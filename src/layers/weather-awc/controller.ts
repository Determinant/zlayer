import { type RadarFile, type RadarContours, AWC_ADVISORY_PRODUCTS, awcGridProduct, type AwcAdvisoryProduct, type AwcGridField, type AwcGridProduct, type WeatherAdvisory } from '@zlayer/contracts';
import { createLayerStore } from '../../core/layers/store';
import { createLayerEvents } from '../../core/layers/events';
import type { MapContextAction } from '../../core/map/selection';
import type { AdvisoryState } from './client';
import { createGridController, type GridState } from './grids/controller';
import type { DecodedGrid } from './grids/format';
import { advisoryFrame } from './time';
import { weatherAwcPreferences, type WeatherAwcPreferences } from './preferences';
import { surfaceFrame, type SurfaceStates } from './progs/time';
import type { RadarState } from './radar/client';
import { isSurfacePressureLabel } from './progs/palette';
import type { ProgsCoverageState } from './progs/coverage-client';
import { progsCoverageFrame } from './progs/coverage-time';
import type { ProgsCoverageFile } from '@zlayer/contracts';
import { createProductRefresh, type WeatherClients } from './product-refresh';
import { mountWeatherClock } from './clock';
import { createPreparationDemand } from './grids/preparation-demand';
import { forecastChanges, forecastTimes, reconcileWeatherTime, advisoryEnabled } from './selection';
import type { RadarMotionState } from './radar/motion-client';
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
export function createWeatherController(clients: WeatherClients) {
  const { advisories: client, grids: gridClient, radar: radarClient, motion: motionClient, coverage: coverageClient } = clients;
  const altitudeControls = createLayerEvents<'icing' | 'winds'>();
  const gridController = gridClient && createGridController(gridClient, grid => acceptGrid({ grid }));
  const windController = gridClient && createGridController(gridClient, wind => acceptGrid({ wind }), ['winds']);
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
  let clock: ReturnType<typeof mountWeatherClock> | undefined;
  let picker: ((point: { x: number; y: number }) => string[]) | undefined;
  let locate: ((point: { x: number; y: number }) => { longitude: number; latitude: number } | undefined) | undefined;
  const interaction = createPreparationDemand(() => syncGrid());
  const syncGrid = () => {
    const s = store.getSnapshot(), p = s.preferences;
    const winds = p.awcWindBarbs || p.awcGridMode === 'temperature', scalar = p.awcGridMode !== 'none' && p.awcGridMode !== 'temperature';
    const shared = { time: s.selectedTime ?? s.now, concurrency: winds && scalar ? 1 : 2, pausePreparation: interaction.paused,
      online: typeof navigator === 'undefined' || navigator.onLine, visible: typeof document === 'undefined' || document.visibilityState !== 'hidden' };
    gridController?.configure({ ...shared, enabled: p.awcEnabled, mode: scalar ? p.awcGridMode : 'none', altitude: p.awcGridAltitude });
    windController?.configure({ ...shared, enabled: p.awcEnabled && winds, mode: 'temperature', altitude: p.awcWindAltitude,
      prepareTimeline: p.awcGridMode === 'temperature' });
  };
  const reconcileAndPublish = (patch: Partial<WeatherState>) => {
    const next = reconcileWeatherTime({ ...store.getSnapshot(), ...patch }, Date.now());
    store.publish(next);
  };
  const acceptGrid = (patch: Pick<Partial<WeatherState>, 'grid' | 'wind'>) => {
    const previous = store.getSnapshot();
    reconcileAndPublish(patch);
    // Discovery can retire the selected stop. Reconfigure only when that shared
    // selection changes, not on every child progress/receipt notification.
    const current = store.getSnapshot();
    if (current.selectedTime !== previous.selectedTime || current.selectedTime === null &&
      Math.floor(current.now / 3600_000) !== Math.floor(previous.now / 3600_000)) syncGrid();
  };
  const publishDisplay = (patch: Partial<WeatherState>) => store.publish({ ...store.getSnapshot(), ...patch });
  const products = createProductRefresh(clients, store.getSnapshot, patch => {
    reconcileAndPublish(patch); clock?.schedule(); syncGrid();
  });
  const demand = () => { products.demand(); syncGrid(); };
  const visibleAdvisories = (): WeatherAdvisory[] => {
    const s = store.getSnapshot(), p = s.preferences;
    if (!p.awcEnabled) return [];
    return AWC_ADVISORY_PRODUCTS.flatMap(product => advisoryFrame(s.products[product].snapshot, s.selectedTime ?? s.now).advisories)
      .filter(a => advisoryEnabled(a, p));
  };
  const detach = () => {
    interaction.reset();
    clock?.stop(); clock = undefined;
    products.detach();
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
      products.retry(['advisories']); demand();
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
      products.retry(['motion', 'radar']); demand();
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
      products.retry(['progs', 'coverage']);
      demand();
    },
    setProgsRenderError(progsRenderError: string | undefined) {
      if (store.getSnapshot().progsRenderError !== progsRenderError) publishDisplay({ progsRenderError });
    },
    altitudeControls: altitudeControls.events,
    showAltitudeControls(product: 'icing' | 'winds') { altitudeControls.emit(product); },
    setForecastInteraction(source: 'map' | 'controls', active: boolean) {
      interaction.set(source, active); syncGrid();
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
      if ('awcGridAltitude' in patch || 'awcWindAltitude' in patch || 'awcGridMode' in patch) interaction.pause();
      input?.change(patch);
    },
    retryForecasts() {
      reconcileAndPublish({ forecastRetry: store.getSnapshot().forecastRetry + 1 });
      gridController?.retry(); windController?.retry();
    },
    selectTime(time: number | null) {
      if (time !== store.getSnapshot().selectedTime) interaction.pause();
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
      products.attach();
      clock = mountWeatherClock(store.getSnapshot, () => { reconcileAndPublish({ now: Date.now() }); demand(); });
    },
    detach,
  };
}
export type WeatherController = ReturnType<typeof createWeatherController>;
