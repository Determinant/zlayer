import { type RadarFile, type RadarContours, AWC_ADVISORY_PRODUCTS, SURFACE_PRODUCTS, awcGridProduct, type AwcAdvisoryProduct, type AwcGridField, type AwcGridProduct, type SurfaceProduct, type SurfaceSnapshot, type WeatherAdvisory } from '@zlayer/contracts';
import { createLayerStore } from '../../core/layers/store';
import { createLayerEvents } from '../../core/layers/events';
import type { MapContextAction } from '../../core/map/selection';
import { OnDemandRefresh } from '../../core/layers/on-demand-refresh';
import { AdvisoryClient, ADVISORY_REFRESH_MS, type AdvisoryState } from './client';
import { GridClient } from './grids/client';
import { createGridController, gridTimes, type GridState } from './grids/controller';
import type { DecodedGrid } from './grids/format';
import { advisoryFrame } from './time';
import { weatherAwcPreferences, type WeatherAwcPreferences } from './preferences';
import { ProgsClient, type SurfaceState } from './progs/client';
import { surfaceFrame, type SurfaceStates } from './progs/time';
import { RadarClient, type RadarState } from './radar/client';
import { radarTimes } from './radar/time';
import { isSurfacePressureLabel } from './progs/palette';
import { RadarMotionClient, type RadarMotionState } from './radar/motion-client';
import type { RadarMotionFile, RadarMotionSnapshot } from '@zlayer/contracts';

export type WeatherAwcInput = WeatherAwcPreferences & {
  change(patch: Partial<WeatherAwcPreferences>): void;
};
export type GridDisplay = { data: DecodedGrid; mode: AwcGridField; sld: boolean };
export type WeatherTimeProduct = AwcAdvisoryProduct | AwcGridProduct | 'progs' | 'radar';
type State = {
  preferences: WeatherAwcPreferences;
  now: number;
  selectedTime: number | null;
  selectedIds: string[];
  gridPoint?: { longitude: number; latitude: number } | undefined;
  grid: GridState;
  wind: GridState;
  windDisplay?: DecodedGrid | undefined;
  windRenderError?: string | undefined;
  gridDisplay?: GridDisplay | undefined;
  gridRenderError?: string | undefined;
  /** Explicit recovery requests; healthy renderers keep their current resources. */
  forecastRetry: number;
  products: Record<AwcAdvisoryProduct, AdvisoryState>;
  advisoryRetry: number;
  advisoryDisplay: { loading: boolean; ids: string[]; error?: string };
  radar: RadarState;
  radarRetry: number;
  radarDisplay: { loading: boolean; sites: string[]; error?: string };
  radarMotion: RadarMotionState;
  radarMotionDisplay: { loading: boolean; cells: number; stations: number; oldest?: number; newest?: number; error?: string };
  progs: SurfaceStates;
  progsRenderError?: string | undefined;
};
export const shadedGrid = (state: State): GridState => state.preferences.awcGridMode === 'temperature' ? state.wind : state.grid;
/** One status per requested data stream, even when temperature and barbs share it.
 * Every requested renderer must commit before that stream is ready. */
export function forecastStreams(state: State) {
  const p = state.preferences, shading = awcGridProduct(p.awcGridMode);
  const products: AwcGridProduct[] = !p.awcEnabled ? [] : [
    ...(shading && shading !== 'winds' ? [shading] : []),
    ...(p.awcWindBarbs || shading === 'winds' ? ['winds' as const] : []),
  ];
  return products.map(product => {
    const grid = product === 'winds' ? state.wind : state.grid, record = grid.products[product];
    const shade = product === shading, barbs = product === 'winds' && p.awcWindBarbs;
    const shaded = shade && state.gridDisplay?.mode === p.awcGridMode ? state.gridDisplay.data : undefined;
    const symbols = barbs ? state.windDisplay : undefined;
    const renderError = (shade ? state.gridRenderError : undefined) || (barbs ? state.windRenderError : undefined);
    return { product, grid, record, shown: shaded ?? symbols, renderError, error: grid.error || renderError,
      loading: grid.loading || !record.manifest && record.loading,
      rendering: !!grid.data && (shade && grid.data !== shaded || barbs && grid.data !== symbols) };
  });
}
export function forecastPreparation(state: State) {
  const tasks = forecastStreams(state).map(({ grid }) => grid.preparation).filter(task => !!task);
  if (!tasks.length) return undefined;
  // A newly enabled stream may still be discovering its total. Its pending
  // metadata must not erase completed saves from the other stream.
  return tasks.reduce((sum, task) => ({
    ready: sum.ready + task.ready, total: sum.total + task.total,
    failed: sum.failed + task.failed, limited: sum.limited || !!task.limited,
  }), { ready: 0, total: 0, failed: 0, limited: false });
}
function advisoryEnabled(a: WeatherAdvisory, p: WeatherAwcPreferences): boolean {
  return a.product === 'gairmet' ? a.hazard === 'FZLVL' || a.hazard === 'M_FZLVL' ? p.awcFreezing : p.awcGairmet &&
    (a.hazard === 'ICE' ? p.awcIcing : a.hazard.startsWith('TURB') ? p.awcTurbulence : a.hazard === 'IFR' ? p.awcIfr
      : a.hazard === 'MT_OBSC' ? p.awcMountain : a.hazard === 'SFC_WND' || a.hazard === 'LLWS' ? p.awcWind : true)
    : a.product === 'cwa' ? p.awcCwa : a.hazard === 'CONVECTIVE' ? p.awcConvective : p.awcSigmet;
}
export function createWeatherController(client: Pick<AdvisoryClient, 'restore' | 'refresh'>, gridClient?: GridClient,
  progsClient?: Pick<ProgsClient, 'restore' | 'refresh'>, radarClient?: Pick<RadarClient, 'restore' | 'refresh' | 'load'>,
  motionClient?: Pick<RadarMotionClient, 'restore' | 'refresh' | 'load'>) {
  const altitudeControls = createLayerEvents<'icing' | 'winds'>();
  const gridController = gridClient && createGridController(gridClient, grid => { publish({ grid }); syncGrid(); });
  const windController = gridClient && createGridController(gridClient, wind => { publish({ wind }); syncGrid(); }, ['winds']);
  const emptyGrid = (): GridState => ({ products: { clouds: { loading: false }, icing: { loading: false }, winds: { loading: false } }, loading: false });
  const store = createLayerStore<State>({ preferences: weatherAwcPreferences.select({}), now: Date.now(),
    selectedTime: null, selectedIds: [], forecastRetry: 0, advisoryRetry: 0, advisoryDisplay: { loading: false, ids: [] },
    grid: gridController?.getSnapshot() ?? emptyGrid(), wind: windController?.getSnapshot() ?? emptyGrid(),
    radar: radarClient?.restore() ?? { loading: false }, radarRetry: 0, radarDisplay: { loading: false, sites: [] },
    radarMotion: motionClient?.restore() ?? { loading: false }, radarMotionDisplay: { loading: false, cells: 0, stations: 0 },
    progs: { analysis: { loading: false }, forecast: { loading: false } },
    products: { gairmet: client.restore('gairmet'), sigmet: client.restore('sigmet'), cwa: client.restore('cwa') } });
  let input: WeatherAwcInput | undefined;
  let scheduler: OnDemandRefresh | undefined;
  let radarScheduler: OnDemandRefresh | undefined;
  let motionScheduler: OnDemandRefresh | undefined;
  let progsScheduler: OnDemandRefresh | undefined;
  let progsRestore: AbortController | undefined;
  let stop: (() => void) | undefined;
  let scheduleClock: (() => void) | undefined;
  let picker: ((point: { x: number; y: number }) => string[]) | undefined;
  let locate: ((point: { x: number; y: number }) => { longitude: number; latitude: number } | undefined) | undefined;
  const interactions = new Set<'map' | 'controls'>();
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let pausePreparation = false;
  const scheduleResume = () => {
    clearTimeout(resumeTimer); resumeTimer = undefined;
    if (!interactions.size) resumeTimer = setTimeout(() => { resumeTimer = undefined; pausePreparation = false; syncGrid(); }, 150);
  };
  const pauseForInput = () => { pausePreparation = true; scheduleResume(); };
  const forecastChanges = (state = store.getSnapshot()) => {
    const changes = new Map<number, Set<WeatherTimeProduct>>(), p = state.preferences;
    const add = (product: WeatherTimeProduct, times: readonly number[]) => {
      for (const time of times) {
        if (!changes.has(time)) changes.set(time, new Set());
        changes.get(time)!.add(product);
      }
    };
    if (p.awcGairmet || p.awcFreezing) add('gairmet', state.products.gairmet.snapshot?.frameTimes ?? []);
    for (const product of ['sigmet', 'cwa'] as const) add(product, state.products[product].snapshot?.advisories
      .filter(a => advisoryEnabled(a, p)).flatMap(a => [a.validFrom, a.validTo!]) ?? []);
    const product = awcGridProduct(p.awcGridMode);
    if (product && product !== 'winds') add(product, gridTimes(state.grid, p.awcGridMode, p.awcGridAltitude));
    if (p.awcWindBarbs || product === 'winds') add('winds', gridTimes(state.wind, 'temperature', p.awcWindAltitude));
    if (p.awcProgs) add('progs', state.progs.forecast.snapshot?.frames.map(frame => frame.validTime) ?? []);
    if (p.awcRadar) add('radar', radarTimes(state.radar.snapshot, state.now));
    return [...changes].sort(([a], [b]) => a - b).map(([time, products]) => ({ time, products: [...products] }));
  };
  const forecastTimes = (state = store.getSnapshot()): readonly number[] => forecastChanges(state).map(change => change.time);
  const syncGrid = () => {
    const s = store.getSnapshot(), p = s.preferences;
    const winds = p.awcWindBarbs || p.awcGridMode === 'temperature', scalar = p.awcGridMode !== 'none' && p.awcGridMode !== 'temperature';
    const shared = { time: s.selectedTime ?? s.now, concurrency: winds && scalar ? 1 : 2, pausePreparation,
      online: typeof navigator === 'undefined' || navigator.onLine, visible: typeof document === 'undefined' || document.visibilityState !== 'hidden' };
    gridController?.configure({ ...shared, enabled: p.awcEnabled, mode: scalar ? p.awcGridMode : 'none', altitude: p.awcGridAltitude });
    windController?.configure({ ...shared, enabled: p.awcEnabled && winds, mode: 'temperature', altitude: p.awcWindAltitude,
      prepareTimeline: p.awcGridMode === 'temperature' });
  };
  const publish = (patch: Partial<State>) => {
    // Mobile timers can remain suspended after a source request completes.
    // Every publication and explicit Now action uses the actual wall clock.
    const next = { ...store.getSnapshot(), ...patch, now: Date.now() };
    // A field/altitude change preserves the absolute selection even without
    // matching coverage. Inactive catalogs validate that selection, but must
    // not populate Next/Prev with steps that change nothing on the map.
    if (next.selectedTime !== null && !forecastTimes(next).includes(next.selectedTime) &&
      ![...Object.values(next.grid.products), ...Object.values(next.wind.products)].some(product => product.manifest?.frames.some(frame => frame.validTime === next.selectedTime)) &&
      !next.progs.forecast.snapshot?.frames.some(frame => frame.validTime === next.selectedTime) &&
      !(next.selectedTime <= next.now && radarTimes(next.radar.snapshot, next.now).some(time => time <= next.selectedTime!))) {
      next.selectedTime = null;
      next.selectedIds = []; next.gridPoint = undefined;
    }
    store.publish(next);
  };
  const productState = (product: AwcAdvisoryProduct, patch: AdvisoryState) => {
    publish({ now: Date.now(), products: { ...store.getSnapshot().products, [product]: patch } });
    scheduleClock?.();
    syncGrid();
  };
  const progsState = (product: SurfaceProduct, patch: SurfaceState) => {
    publish({ now: Date.now(), progs: { ...store.getSnapshot().progs, [product]: patch } });
    syncGrid();
  };
  const demand = () => {
    const p = store.getSnapshot().preferences;
    const ids: AwcAdvisoryProduct[] = [];
    if (p.awcGairmet || p.awcFreezing) ids.push('gairmet');
    if (p.awcSigmet || p.awcConvective) ids.push('sigmet');
    if (p.awcCwa) ids.push('cwa');
    scheduler?.setDemand(ids, p.awcEnabled && navigator.onLine && document.visibilityState !== 'hidden');
    progsScheduler?.setDemand(SURFACE_PRODUCTS, p.awcEnabled && p.awcProgs && navigator.onLine && document.visibilityState !== 'hidden');
    radarScheduler?.setDemand(['radar'], p.awcEnabled && p.awcRadar && navigator.onLine && document.visibilityState !== 'hidden');
    motionScheduler?.setDemand(['motion'], p.awcEnabled && p.awcRadar && p.awcRadarMotion && navigator.onLine && document.visibilityState !== 'hidden');
    syncGrid();
  };
  const visibleAdvisories = (): WeatherAdvisory[] => {
    const s = store.getSnapshot(), p = s.preferences;
    if (!p.awcEnabled) return [];
    return AWC_ADVISORY_PRODUCTS.flatMap(product => advisoryFrame(s.products[product].snapshot, s.selectedTime ?? s.now).advisories)
      .filter(a => advisoryEnabled(a, p));
  };
  const detach = () => {
    clearTimeout(resumeTimer); resumeTimer = undefined; interactions.clear(); pausePreparation = false;
    scheduleClock = undefined;
    stop?.(); stop = undefined;
    scheduler?.destroy(); scheduler = undefined;
    radarScheduler?.destroy(); radarScheduler = undefined;
    motionScheduler?.destroy(); motionScheduler = undefined;
    progsScheduler?.destroy(); progsScheduler = undefined;
    progsRestore?.abort(); progsRestore = undefined;
    picker = undefined; locate = undefined;
    gridController?.detach();
    windController?.detach();
    for (const product of AWC_ADVISORY_PRODUCTS) {
      const state = store.getSnapshot().products[product];
      if (state.loading) productState(product, { ...state, loading: false });
    }
    for (const product of SURFACE_PRODUCTS) {
      const state = store.getSnapshot().progs[product];
      if (state.loading) progsState(product, { ...state, loading: false });
    }
  };
  return {
    ...store, visibleAdvisories, forecastTimes, forecastChanges,
    setAdvisoryDisplay(advisoryDisplay: State['advisoryDisplay']) {
      if (JSON.stringify(store.getSnapshot().advisoryDisplay) !== JSON.stringify(advisoryDisplay)) publish({ advisoryDisplay });
    },
    retryAdvisories() {
      publish({ advisoryRetry: store.getSnapshot().advisoryRetry + 1 });
      scheduler?.setDemand([], false); demand();
    },
    loadRadar(file: RadarFile, signal: AbortSignal, onReady?: (value: RadarContours) => void) {
      if (!radarClient) throw new Error('Radar client is unavailable');
      return radarClient.load(file, signal, onReady);
    },
    setRadarDisplay(radarDisplay: State['radarDisplay']) {
      if (JSON.stringify(store.getSnapshot().radarDisplay) !== JSON.stringify(radarDisplay)) publish({ radarDisplay });
    },
    loadRadarMotion(file: RadarMotionFile, signal: AbortSignal, onReady?: (value: RadarMotionSnapshot) => void) {
      if (!motionClient) throw new Error('Storm motion client is unavailable');
      return motionClient.load(file, signal, onReady);
    },
    setRadarMotionDisplay(radarMotionDisplay: State['radarMotionDisplay']) {
      if (JSON.stringify(store.getSnapshot().radarMotionDisplay) !== JSON.stringify(radarMotionDisplay)) publish({ radarMotionDisplay });
    },
    retryRadar() {
      publish({ radarRetry: store.getSnapshot().radarRetry + 1 });
      motionScheduler?.setDemand([], false);
      radarScheduler?.setDemand([], false); demand();
    },
    surfaceSelection() {
      const s = store.getSnapshot();
      return surfaceFrame(s.progs, s.selectedTime, s.now);
    },
    retryProgs() {
      publish({ forecastRetry: store.getSnapshot().forecastRetry + 1 });
      progsScheduler?.setDemand([], false);
      demand();
    },
    setProgsRenderError(progsRenderError: string | undefined) {
      if (store.getSnapshot().progsRenderError !== progsRenderError) publish({ progsRenderError });
    },
    altitudeControls: altitudeControls.events,
    showAltitudeControls(product: 'icing' | 'winds') { altitudeControls.emit(product); },
    setForecastInteraction(source: 'map' | 'controls', active: boolean) {
      if (active) interactions.add(source); else interactions.delete(source);
      if (interactions.size) pausePreparation = true;
      scheduleResume(); syncGrid();
    },
    setWindDisplay(windDisplay: DecodedGrid | undefined) { if (store.getSnapshot().windDisplay !== windDisplay) publish({ windDisplay }); },
    setWindRenderError(windRenderError: string | undefined) { if (store.getSnapshot().windRenderError !== windRenderError) publish({ windRenderError }); },
    setGridDisplay(gridDisplay: GridDisplay | undefined) {
      const previous = store.getSnapshot().gridDisplay;
      if (previous?.data !== gridDisplay?.data || previous?.mode !== gridDisplay?.mode || previous?.sld !== gridDisplay?.sld) publish({ gridDisplay });
    },
    setGridRenderError(gridRenderError: string | undefined) { if (store.getSnapshot().gridRenderError !== gridRenderError) publish({ gridRenderError }); },
    configure(next: WeatherAwcInput) {
      input = next;
      const preferences = weatherAwcPreferences.select(next);
      if (JSON.stringify(preferences) !== JSON.stringify(store.getSnapshot().preferences)) {
        // Preference changes update the inspected weather without dismissing it.
        // Keep selection identities stable so stowed details do not reopen.
        publish(preferences.awcEnabled ? { preferences } : { preferences, selectedIds: [], gridPoint: undefined });
      }
      demand();
    },
    change(patch: Partial<WeatherAwcPreferences>) {
      if ('awcGridAltitude' in patch || 'awcWindAltitude' in patch || 'awcGridMode' in patch) pauseForInput();
      input?.change(patch);
    },
    retryForecasts() {
      publish({ forecastRetry: store.getSnapshot().forecastRetry + 1 });
      gridController?.retry(); windController?.retry();
    },
    selectTime(time: number | null) {
      if (time !== store.getSnapshot().selectedTime) pauseForInput();
      if (time === null || forecastTimes().includes(time)) publish({ selectedTime: time, selectedIds: [], gridPoint: undefined });
      syncGrid();
    },
    clearSelection() { publish({ selectedIds: [], gridPoint: undefined }); },
    setLocator(next: typeof locate) { locate = next; },
    setPicker(next: typeof picker) { picker = next; },
    contextActions(point: { x: number; y: number }): MapContextAction[] {
      if (!store.getSnapshot().preferences.awcEnabled) return [];
      const ids = picker?.(point) ?? [], gridPoint = locate?.(point);
      if (!ids.length && !gridPoint) return [];
      return [{ id: 'weather-awc:inspect', label: 'Inspect weather', select() {
        if (!store.getSnapshot().preferences.awcEnabled) return;
        // Keep the geographic selection, not a pixel that can move with the camera.
        const visible = new Set(visibleAdvisories().map(advisory => advisory.id));
        const s = store.getSnapshot();
        if (s.preferences.awcProgs && !s.progsRenderError) for (const feature of surfaceFrame(s.progs, s.selectedTime, s.now).frame?.features ?? []) {
          if (s.preferences.awcProgsIsobars || feature.kind !== 'ISOBAR' && !isSurfacePressureLabel(feature)) visible.add(feature.id);
        }
        const selectedIds = ids.filter(id => visible.has(id));
        const currentPoint = store.getSnapshot().gridDisplay || store.getSnapshot().windDisplay ? gridPoint : undefined;
        if (selectedIds.length || currentPoint) publish({ selectedIds, gridPoint: currentPoint });
      } }];
    },
    attach() {
      detach();
      syncGrid(); gridController?.attach(); windController?.attach();
      if (progsClient) {
        const restore = progsRestore = new AbortController();
        for (const product of SURFACE_PRODUCTS) void progsClient.restore(product, restore.signal).then(saved => {
          const current = store.getSnapshot().progs[product];
          if (!restore.signal.aborted && saved.snapshot && !current.snapshot) progsState(product, { ...current, snapshot: saved.snapshot });
        }).catch(() => { /* Optional restoration; live acquisition remains independent. */ });
      }
      scheduler = new OnDemandRefresh({ intervalMs: ADVISORY_REFRESH_MS, debounceMs: 0,
        onState(loading) {
          if (!loading) for (const product of AWC_ADVISORY_PRODUCTS) {
            const current = store.getSnapshot().products[product];
            if (current.loading) productState(product, { ...current, loading: false });
          }
        }, onError() {}, async refresh(ids, signal) {
          for (const product of ids as AwcAdvisoryProduct[]) {
            signal.throwIfAborted();
            const previous = store.getSnapshot().products[product];
            productState(product, { ...previous, loading: true });
            try {
              const snapshot = await client.refresh(product, signal);
              signal.throwIfAborted();
              productState(product, { snapshot, checkedAt: Date.now(), loading: false });
            } catch (error) {
              if (signal.aborted) return;
              productState(product, { ...previous, loading: false, error: error instanceof Error ? error.message : 'Refresh failed' });
            }
          }
        } });
      if (progsClient) progsScheduler = new OnDemandRefresh({ intervalMs: ADVISORY_REFRESH_MS, retryIntervalMs: 30_000, debounceMs: 0,
        onState(loading) {
          if (!loading) for (const product of SURFACE_PRODUCTS) {
            const record = store.getSnapshot().progs[product];
            if (record.loading) progsState(product, { ...record, loading: false });
          }
        }, onError() {}, async refresh(ids, signal) {
          const results = await Promise.allSettled((ids as SurfaceProduct[]).map(async product => {
            const previous = store.getSnapshot().progs[product];
            progsState(product, { ...previous, loading: true });
            try {
              const ready = (snapshot: SurfaceSnapshot) => {
                if (!signal.aborted) progsState(product, { snapshot, checkedAt: Date.now(), loading: false });
              };
              const snapshot = await progsClient.refresh(product, signal, Date.now(), ready);
              signal.throwIfAborted();
              progsState(product, { snapshot, checkedAt: Date.now(), loading: false });
            } catch (error) {
              if (!signal.aborted) progsState(product, { ...store.getSnapshot().progs[product], loading: false, error: error instanceof Error ? error.message : 'Refresh failed' });
              throw error;
            }
          }));
          const failure = results.find(result => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        } });
      if (radarClient) radarScheduler = new OnDemandRefresh({ intervalMs: 60_000, retryIntervalMs: 30_000, debounceMs: 0,
        onState(loading) { if (!loading && store.getSnapshot().radar.loading) publish({ radar: { ...store.getSnapshot().radar, loading: false } }); },
        onError() {}, async refresh(_ids, signal) {
          publish({ radar: { ...store.getSnapshot().radar, loading: true } });
          try {
            const snapshot = await radarClient.refresh(signal); signal.throwIfAborted();
            publish({ radar: { snapshot, loading: false } });
          } catch (error) {
            if (!signal.aborted) publish({ radar: { ...store.getSnapshot().radar, loading: false, error: error instanceof Error ? error.message : 'Radar refresh failed' } });
            throw error;
          }
        } });
      if (motionClient) motionScheduler = new OnDemandRefresh({ intervalMs: 60_000, retryIntervalMs: 30_000, debounceMs: 0,
        onState(loading) { if (!loading && store.getSnapshot().radarMotion.loading) publish({ radarMotion: { ...store.getSnapshot().radarMotion, loading: false } }); },
        onError() {}, async refresh(_ids, signal) {
          publish({ radarMotion: { ...store.getSnapshot().radarMotion, loading: true } });
          try {
            const snapshot = await motionClient.refresh(signal); signal.throwIfAborted();
            publish({ radarMotion: { snapshot, loading: false } });
          } catch (error) {
            if (!signal.aborted) publish({ radarMotion: { ...store.getSnapshot().radarMotion, loading: false, error: error instanceof Error ? error.message : 'Storm motion refresh failed' } });
            throw error;
          }
        } });
      let timer: ReturnType<typeof setTimeout>;
      scheduleClock = () => {
        clearTimeout(timer);
        const now = Date.now();
        const boundaries = Object.values(store.getSnapshot().products).flatMap(p =>
          p.snapshot?.advisories.flatMap(a => [a.validFrom, ...(a.validTo === null ? [] : [a.validTo])]) ?? []);
        const next = Math.min(now + 15_000, ...boundaries.filter(t => t > now));
        timer = setTimeout(tick, next - now);
      };
      const tick = () => { publish({ now: Date.now() }); demand(); scheduleClock?.(); };
      document.addEventListener('visibilitychange', tick);
      window.addEventListener('online', tick);
      window.addEventListener('offline', tick);
      window.addEventListener('pageshow', tick);
      window.addEventListener('focus', tick);
      stop = () => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', tick);
        window.removeEventListener('online', tick);
        window.removeEventListener('offline', tick);
        window.removeEventListener('pageshow', tick);
        window.removeEventListener('focus', tick);
      };
      tick();
    },
    detach,
  };
}
export type WeatherController = ReturnType<typeof createWeatherController>;
