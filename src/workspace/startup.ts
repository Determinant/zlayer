import type { NavigationLayerId } from '@zlayer/contracts';
import type { PluginControl } from '../core/layers/use-plugins';
import type { ChartCacheState } from '../layers/charts/use-cache';
import type { LayerVisibility } from '../layers/navigation/definitions';
import type { useNavigationData } from '../layers/navigation/use-data';
import type { ObstructionStatus } from '../layers/obstructions/types';
import type { PlatesSnapshot } from '../layers/plates/layer';
import type { RouteLoadStatus } from '../layers/routes/use-plan';
import type { TerrainStatus } from '../layers/terrain/types';
import type { MetarLayerSnapshot } from '../layers/metar-taf/metar/layer';
import type { ReportStatus } from '../layers/metar-taf/station-weather';
import { forecastPreparation, forecastStreams, type WeatherController } from '../layers/weather-awc/controller';
import type { WorkspaceReadContext } from './read-context';

export type StartupStep = {
  id: string;
  label: string;
  state: 'waiting' | 'loading' | 'rendering' | 'ready' | 'cached' | 'limited' | 'unavailable';
  /** Live weather can finish independently after the workspace opens. */
  blocking?: boolean;
  detail?: string;
};
type Work = Omit<StartupStep, 'id' | 'label'>;
export const startupStepPending = (step: Work) =>
  step.state === 'loading' || step.state === 'waiting' || step.state === 'rendering';
export const startupStepBlocking = (step: Work) => step.blocking !== false && startupStepPending(step);

export function weatherStartupWork(state: ReturnType<WeatherController['getSnapshot']>, online: boolean): Work | undefined {
  const p = state.preferences;
  if (!p.awcEnabled) return undefined;
  const records = [
    ...(p.awcGairmet || p.awcFreezing ? [state.products.gairmet] : []),
    ...(p.awcSigmet || p.awcConvective ? [state.products.sigmet] : []),
    ...(p.awcCwa ? [state.products.cwa] : []),
    ...(p.awcRadar ? [{ ...state.radar, checkedAt: state.radar.snapshot?.checkedAt }] : []),
    ...(p.awcProgs ? Object.values(state.progs) : []),
  ];
  const forecasts = forecastStreams(state);
  if (!records.length && !forecasts.length) return undefined;
  const prepared = forecastPreparation(state);
  const error = state.advisoryDisplay.error || p.awcRadar && state.radarDisplay.error || records.some(record => record.error) || p.awcProgs && state.progsRenderError || forecasts.some(({ grid, record, error }) =>
    error || record.error || record.storageError || grid.preparation?.failed || grid.preparation?.limited);
  const pending = records.some(record => record.loading || online && !record.snapshot && !record.error) || forecasts.some(({ grid, record, loading }) =>
    loading || record.loading || online && (!record.manifest && !record.error || grid.preparation && grid.preparation.ready < grid.preparation.total));
  const available = records.some(record => record.snapshot) || forecasts.some(f => f.shown);
  const cached = available && (!online || records.some(record => record.snapshot && !record.checkedAt) ||
    forecasts.some(({ record, shown }) => shown && !record.checkedAt));
  return { blocking: false, state: error ? available ? 'limited' : 'unavailable'
    : pending ? 'loading' : (state.advisoryDisplay.loading || p.awcRadar && state.radarDisplay.loading || forecasts.some(f => f.rendering)) ? 'rendering'
      : cached ? 'cached' : available ? 'ready' : 'unavailable',
    ...(pending && !error && prepared && prepared.ready < prepared.total
      ? { detail: `Preparing forecasts · ${prepared.ready}/${prepared.total}` } : {}) };
}

/** Show actual startup demand, named by the registered plugin that owns it. */
export function workspaceStartupSteps({ context, plugins, navigation, routes, plates, charts, terrain, obstructions, metar, awc, mapIdle }: {
  context: WorkspaceReadContext | undefined;
  plugins: readonly Pick<PluginControl, 'id' | 'title' | 'status' | 'enabled'>[];
  navigation: Pick<ReturnType<typeof useNavigationData>, 'loadState' | 'loading' | 'issues' | 'airways'> & {
    enabled: boolean; visibility: LayerVisibility;
  };
  routes: { enabled: boolean; hasEntries: boolean; status: RouteLoadStatus };
  plates: { enabled: boolean; snapshot: Pick<PlatesSnapshot, 'mapSelection' | 'mapImage' | 'mapRestoreError'> };
  charts: { count: number; state: ChartCacheState };
  terrain: { enabled: boolean; state: TerrainStatus['state'] };
  obstructions: { enabled: boolean; state: ObstructionStatus['state'] };
  metar: { snapshot: Pick<MetarLayerSnapshot, 'state'>; reports: ReportStatus[] };
  awc: Work | undefined;
  mapIdle: boolean;
}): StartupStep[] {
  const steps: StartupStep[] = [{ id: 'workspace', label: 'Workspace', state: context ? 'ready' : 'loading' }];
  if (!context) return steps;
  const work = new Map<string, Work>();
  const { visibility } = navigation;
  if (navigation.enabled && Object.values(visibility).some(Boolean)) {
    const limited = navigation.issues.length > 0 || Object.entries(navigation.loadState).some(([id, state]) =>
      visibility[id as NavigationLayerId] && (state === 'error' || state === 'partial')) ||
      (visibility.fixes && !!context.routing.airways && !navigation.airways);
    work.set('navigation', { state: navigation.loading ? 'loading' : limited ? 'limited' : 'ready' });
  }
  if (routes.enabled && routes.hasEntries) work.set('routes', {
    state: routes.status === 'loading' ? 'loading' : routes.status === 'error' ? 'unavailable'
      : routes.status === 'partial' ? 'limited' : 'ready' });
  if (plates.enabled && plates.snapshot.mapSelection) work.set('plates', {
    state: plates.snapshot.mapImage ? 'ready' : plates.snapshot.mapRestoreError ? 'unavailable' : 'loading' });
  if (charts.count > 0) work.set('charts', {
    state: charts.state === 'preparing' ? 'loading' : charts.state === 'unavailable' ? 'unavailable'
      : mapIdle ? 'ready' : 'rendering' });
  for (const [id, { enabled, state }] of [['terrain', terrain], ['obstructions', obstructions]] as const) {
    // Idle means no requested coverage; zoom means no work at this scale.
    // Neither is a failed or unfinished startup task.
    if (enabled && state !== 'idle' && state !== 'zoom') work.set(id, { state: state === 'error' ? 'unavailable' : state });
  }
  const { status } = metar.snapshot.state, reports = metar.reports;
  if (status !== 'idle' || reports.length) work.set('metar', { blocking: false,
    state: status === 'loading' || reports.includes('loading') ? 'loading'
      : status === 'error' || reports.includes('unavailable') ? status === 'current' || status === 'stale' || reports.includes('ready') || reports.includes('cached') ? 'limited' : 'unavailable'
        : status === 'stale' || reports.includes('cached') ? 'cached' : 'ready' });
  if (awc) work.set('weather-awc', awc);
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const task: Work | undefined = plugin.status === 'failed' || plugin.status === 'blocked' ? { state: 'unavailable' }
      : plugin.status === 'starting' ? { state: 'loading' }
        : plugin.status === 'degraded' ? { state: 'limited' } : work.get(plugin.id);
    if (task) steps.push({ id: plugin.id, label: plugin.title, ...task });
  }
  steps.push({ id: 'map', label: 'Map', state: mapIdle ? 'ready' : 'loading' });
  return steps;
}
