import { type RadarFile, type RadarContours, AWC_ADVISORY_PRODUCTS, SURFACE_PRODUCTS, awcGridProduct, type AwcAdvisoryProduct, type AwcGridField, type AwcGridProduct, type SurfaceProduct, type SurfaceSnapshot, type WeatherAdvisory } from '@zlayer/contracts';
import { createLayerStore } from '../../core/layers/store';
import { createLayerEvents } from '../../core/layers/events';
import type { MapContextAction } from '../../core/map/selection';
import { OnDemandRefresh } from '../../core/layers/on-demand-refresh';
import { AdvisoryClient, ADVISORY_REFRESH_MS, type AdvisoryState } from './client';
import { GridClient } from './grids/client';
import { createGridController, type GridState } from './grids/controller';
import type { DecodedGrid } from './grids/format';
import { advisoryFrame } from './time';
import { weatherAwcPreferences, type WeatherAwcPreferences } from './preferences';
import { ProgsClient, type SurfaceState } from './progs/client';
import { surfaceFrame, type SurfaceStates } from './progs/time';
import { RadarClient, type RadarState } from './radar/client';
import { isSurfacePressureLabel } from './progs/palette';
import { ProgsCoverageClient, type ProgsCoverageState } from './progs/coverage-client';
import { progsCoverageFrame } from './progs/coverage-time';
import type { ProgsCoverageFile } from '@zlayer/contracts';
import { catalogRefresh, stopRefresh } from './catalog-refresh';
import { forecastChanges, forecastTimes, reconcileWeatherTime, advisoryEnabled } from './selection';
import { RadarMotionClient, type RadarMotionState } from './radar/motion-client';
import type { RadarMotionFile, RadarMotionSnapshot } from '@zlayer/contracts';

export type WeatherAwcInput = WeatherAwcPreferences & {
  change(patch: Partial<WeatherAwcPreferences>): void;
};
export type GridDisplay = { data: DecodedGrid; mode: AwcGridField; sld: boolean };
export type WeatherTimeProduct = AwcAdvisoryProduct | AwcGridProduct | 'progs' | 'radar';
export type WeatherState = {
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
  progsRetry: number;
  coverage: ProgsCoverageState;
  coverageDisplay: { loading: boolean; validTime?: number; error?: string };
  progsRenderError?: string | undefined;
};
export const shadedGrid = (state: WeatherState): GridState => state.preferences.awcGridMode === 'temperature' ? state.wind : state.grid;
/** One status per requested data stream, even when temperature and barbs share it.
 * Every requested renderer must commit before that stream is ready. */
export function forecastStreams(state: WeatherState) {
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
export function forecastPreparation(state: WeatherState) {
  const tasks = forecastStreams(state).map(({ grid }) => grid.preparation).filter(task => !!task);
  if (!tasks.length) return undefined;
  // A newly enabled stream may still be discovering its total. Its pending
  // metadata must not erase completed saves from the other stream.
  return tasks.reduce((sum, task) => ({
    ready: sum.ready + task.ready, total: sum.total + task.total,
    failed: sum.failed + task.failed, limited: sum.limited || !!task.limited,
  }), { ready: 0, total: 0, failed: 0, limited: false });
}
type WeatherClients = {
  advisories: Pick<AdvisoryClient, 'restore' | 'refresh'>;
  grids?: GridClient;
  progs?: Pick<ProgsClient, 'restore' | 'refresh'>;
  radar?: Pick<RadarClient, 'restore' | 'refresh' | 'load'>;
  motion?: Pick<RadarMotionClient, 'restore' | 'refresh' | 'load'>;
  coverage?: Pick<ProgsCoverageClient, 'restore' | 'refresh' | 'load'>;
};
export function createWeatherController({ advisories: client, grids: gridClient, progs: progsClient,
  radar: radarClient, motion: motionClient, coverage: coverageClient }: WeatherClients) {
  const altitudeControls = createLayerEvents<'icing' | 'winds'>();
  const gridController = gridClient && createGridController(gridClient, grid => { reconcileAndPublish({ grid }); syncGrid(); });
  const windController = gridClient && createGridController(gridClient, wind => { reconcileAndPublish({ wind }); syncGrid(); }, ['winds']);
  const emptyGrid = (): GridState => ({ products: { clouds: { loading: false }, icing: { loading: false }, winds: { loading: false } }, loading: false });
  const store = createLayerStore<WeatherState>({ preferences: weatherAwcPreferences.select({}), now: Date.now(),
    selectedTime: null, selectedIds: [], forecastRetry: 0, advisoryRetry: 0, advisoryDisplay: { loading: false, ids: [] },
    grid: gridController?.getSnapshot() ?? emptyGrid(), wind: windController?.getSnapshot() ?? emptyGrid(),
    radar: radarClient?.restore() ?? { loading: false }, radarRetry: 0, radarDisplay: { loading: false, sites: [] },
    radarMotion: motionClient?.restore() ?? { loading: false }, radarMotionDisplay: { loading: false, cells: 0, stations: 0 },
    coverage: coverageClient?.restore() ?? { loading: false }, coverageDisplay: { loading: false },
    progsRetry: 0, progs: { analysis: { loading: false }, forecast: { loading: false } },
    products: { gairmet: client.restore('gairmet'), sigmet: client.restore('sigmet'), cwa: client.restore('cwa') } });
  let input: WeatherAwcInput | undefined;
  let scheduler: OnDemandRefresh | undefined;
  let radarScheduler: OnDemandRefresh | undefined;
  let motionScheduler: OnDemandRefresh | undefined;
  let coverageScheduler: OnDemandRefresh | undefined;
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
  const syncGrid = () => {
    const s = store.getSnapshot(), p = s.preferences;
    const winds = p.awcWindBarbs || p.awcGridMode === 'temperature', scalar = p.awcGridMode !== 'none' && p.awcGridMode !== 'temperature';
    const shared = { time: s.selectedTime ?? s.now, concurrency: winds && scalar ? 1 : 2, pausePreparation,
      online: typeof navigator === 'undefined' || navigator.onLine, visible: typeof document === 'undefined' || document.visibilityState !== 'hidden' };
    gridController?.configure({ ...shared, enabled: p.awcEnabled, mode: scalar ? p.awcGridMode : 'none', altitude: p.awcGridAltitude });
    windController?.configure({ ...shared, enabled: p.awcEnabled && winds, mode: 'temperature', altitude: p.awcWindAltitude,
      prepareTimeline: p.awcGridMode === 'temperature' });
  };
  const reconcileAndPublish = (patch: Partial<WeatherState>) => {
    const next = reconcileWeatherTime({ ...store.getSnapshot(), ...patch }, Date.now());
    store.publish(next);
  };
  const publishDisplay = (patch: Partial<WeatherState>) => store.publish({ ...store.getSnapshot(), ...patch });
  const productState = (product: AwcAdvisoryProduct, patch: AdvisoryState) => {
    reconcileAndPublish({ products: { ...store.getSnapshot().products, [product]: patch } });
    scheduleClock?.();
    syncGrid();
  };
  const progsState = (product: SurfaceProduct, patch: SurfaceState) => {
    reconcileAndPublish({ progs: { ...store.getSnapshot().progs, [product]: patch } });
    syncGrid();
  };
  const demand = () => {
    const p = store.getSnapshot().preferences;
    const ids: AwcAdvisoryProduct[] = [];
    if (p.awcGairmet || p.awcFreezing) ids.push('gairmet');
    if (p.awcSigmet || p.awcConvective) ids.push('sigmet');
    if (p.awcCwa) ids.push('cwa');
    scheduler?.setDemand(ids, p.awcEnabled && navigator.onLine && document.visibilityState !== 'hidden');
    coverageScheduler?.setDemand(['coverage'], p.awcEnabled && p.awcProgs && p.awcProgsCoverage && navigator.onLine && document.visibilityState !== 'hidden');
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
    stopRefresh(scheduler); scheduler = undefined;
    stopRefresh(radarScheduler); radarScheduler = undefined;
    stopRefresh(motionScheduler); motionScheduler = undefined;
    stopRefresh(coverageScheduler); coverageScheduler = undefined;
    stopRefresh(progsScheduler); progsScheduler = undefined;
    progsRestore?.abort(); progsRestore = undefined;
    picker = undefined; locate = undefined;
    gridController?.detach();
    windController?.detach();
  };
  return {
    ...store, visibleAdvisories,
    forecastTimes: () => forecastTimes(store.getSnapshot()),
    forecastChanges: () => forecastChanges(store.getSnapshot()),
    setAdvisoryDisplay(advisoryDisplay: WeatherState['advisoryDisplay']) {
      if (JSON.stringify(store.getSnapshot().advisoryDisplay) !== JSON.stringify(advisoryDisplay)) publishDisplay({ advisoryDisplay });
    },
    retryAdvisories() {
      reconcileAndPublish({ advisoryRetry: store.getSnapshot().advisoryRetry + 1 });
      scheduler?.setDemand([], false); demand();
    },
    loadRadar(file: RadarFile, signal: AbortSignal, onReady?: (value: RadarContours) => void) {
      if (!radarClient) throw new Error('Radar client is unavailable');
      return radarClient.load(file, signal, onReady);
    },
    setRadarDisplay(radarDisplay: WeatherState['radarDisplay']) {
      if (JSON.stringify(store.getSnapshot().radarDisplay) !== JSON.stringify(radarDisplay)) publishDisplay({ radarDisplay });
    },
    loadRadarMotion(file: RadarMotionFile, signal: AbortSignal, onReady?: (value: RadarMotionSnapshot) => void) {
      if (!motionClient) throw new Error('Storm motion client is unavailable');
      return motionClient.load(file, signal, onReady);
    },
    setRadarMotionDisplay(radarMotionDisplay: WeatherState['radarMotionDisplay']) {
      if (JSON.stringify(store.getSnapshot().radarMotionDisplay) !== JSON.stringify(radarMotionDisplay)) publishDisplay({ radarMotionDisplay });
    },
    retryRadar() {
      reconcileAndPublish({ radarRetry: store.getSnapshot().radarRetry + 1 });
      motionScheduler?.setDemand([], false);
      radarScheduler?.setDemand([], false); demand();
    },
    coverageSelection() {
      const state = store.getSnapshot();
      return progsCoverageFrame(state.coverage.snapshot, state.selectedTime, state.now);
    },
    loadCoverage(file: ProgsCoverageFile, signal: AbortSignal) {
      if (!coverageClient) throw new Error('NDFD coverage client is unavailable');
      return coverageClient.load(file, signal);
    },
    setCoverageDisplay(coverageDisplay: WeatherState['coverageDisplay']) {
      if (JSON.stringify(store.getSnapshot().coverageDisplay) !== JSON.stringify(coverageDisplay)) publishDisplay({ coverageDisplay });
    },
    surfaceSelection() {
      const s = store.getSnapshot();
      return surfaceFrame(s.progs, s.selectedTime, s.now);
    },
    retryProgs() {
      reconcileAndPublish({ progsRetry: store.getSnapshot().progsRetry + 1 });
      progsScheduler?.setDemand([], false);
      coverageScheduler?.setDemand([], false);
      demand();
    },
    setProgsRenderError(progsRenderError: string | undefined) {
      if (store.getSnapshot().progsRenderError !== progsRenderError) publishDisplay({ progsRenderError });
    },
    altitudeControls: altitudeControls.events,
    showAltitudeControls(product: 'icing' | 'winds') { altitudeControls.emit(product); },
    setForecastInteraction(source: 'map' | 'controls', active: boolean) {
      if (active) interactions.add(source); else interactions.delete(source);
      if (interactions.size) pausePreparation = true;
      scheduleResume(); syncGrid();
    },
    setWindDisplay(windDisplay: DecodedGrid | undefined) { if (store.getSnapshot().windDisplay !== windDisplay) publishDisplay({ windDisplay }); },
    setWindRenderError(windRenderError: string | undefined) { if (store.getSnapshot().windRenderError !== windRenderError) publishDisplay({ windRenderError }); },
    setGridDisplay(gridDisplay: GridDisplay | undefined) {
      const previous = store.getSnapshot().gridDisplay;
      if (previous?.data !== gridDisplay?.data || previous?.mode !== gridDisplay?.mode || previous?.sld !== gridDisplay?.sld) publishDisplay({ gridDisplay });
    },
    setGridRenderError(gridRenderError: string | undefined) { if (store.getSnapshot().gridRenderError !== gridRenderError) publishDisplay({ gridRenderError }); },
    configure(next: WeatherAwcInput) {
      input = next;
      const preferences = weatherAwcPreferences.select(next);
      if (JSON.stringify(preferences) !== JSON.stringify(store.getSnapshot().preferences)) {
        // Preference changes update the inspected weather without dismissing it.
        // Keep selection identities stable so stowed details do not reopen.
        reconcileAndPublish(preferences.awcEnabled ? { preferences } : { preferences, selectedIds: [], gridPoint: undefined });
      }
      demand();
    },
    change(patch: Partial<WeatherAwcPreferences>) {
      if ('awcGridAltitude' in patch || 'awcWindAltitude' in patch || 'awcGridMode' in patch) pauseForInput();
      input?.change(patch);
    },
    retryForecasts() {
      reconcileAndPublish({ forecastRetry: store.getSnapshot().forecastRetry + 1 });
      gridController?.retry(); windController?.retry();
    },
    selectTime(time: number | null) {
      if (time !== store.getSnapshot().selectedTime) pauseForInput();
      if (time === null || forecastTimes(store.getSnapshot()).includes(time)) reconcileAndPublish({ selectedTime: time, selectedIds: [], gridPoint: undefined });
      syncGrid();
    },
    clearSelection() { reconcileAndPublish({ selectedIds: [], gridPoint: undefined }); },
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
        if (selectedIds.length || currentPoint) reconcileAndPublish({ selectedIds, gridPoint: currentPoint });
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
      if (radarClient) radarScheduler = catalogRefresh({ intervalMs: 60_000,
        read: () => store.getSnapshot().radar, publish: radar => reconcileAndPublish({ radar }),
        refresh: signal => radarClient.refresh(signal) });
      if (motionClient) motionScheduler = catalogRefresh({ intervalMs: 60_000,
        read: () => store.getSnapshot().radarMotion, publish: radarMotion => reconcileAndPublish({ radarMotion }),
        refresh: signal => motionClient.refresh(signal) });
      if (coverageClient) coverageScheduler = catalogRefresh({ intervalMs: ADVISORY_REFRESH_MS,
        read: () => store.getSnapshot().coverage, publish: coverage => reconcileAndPublish({ coverage }),
        refresh: (signal, ready) => coverageClient.refresh(signal, ready) });
      let timer: ReturnType<typeof setTimeout>;
      scheduleClock = () => {
        clearTimeout(timer);
        const now = Date.now();
        const boundaries = Object.values(store.getSnapshot().products).flatMap(p =>
          p.snapshot?.advisories.flatMap(a => [a.validFrom, ...(a.validTo === null ? [] : [a.validTo])]) ?? []);
        const next = Math.min(now + 15_000, ...boundaries.filter(t => t > now));
        timer = setTimeout(tick, next - now);
      };
      const tick = () => { reconcileAndPublish({ now: Date.now() }); demand(); scheduleClock?.(); };
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
