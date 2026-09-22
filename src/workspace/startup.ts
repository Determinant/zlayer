import type { NavigationLayerId } from '@zlayer/contracts';
import type { ChartCacheState } from '../layers/charts/use-cache';
import type { LayerVisibility } from '../layers/navigation/definitions';
import type { useNavigationData } from '../layers/navigation/use-data';
import type { ObstructionStatus } from '../layers/obstructions/types';
import type { PlatesSnapshot } from '../layers/plates/layer';
import type { RouteLoadStatus } from '../layers/routes/use-plan';
import type { TerrainStatus } from '../layers/terrain/types';
import type { WorkspaceReadContext } from './read-context';

export type StartupStep = {
  label: string;
  state: 'waiting' | 'loading' | 'rendering' | 'ready' | 'limited' | 'unavailable' | 'not-needed';
};
export const startupStepPending = (step: StartupStep) =>
  step.state === 'loading' || step.state === 'waiting' || step.state === 'rendering';

/** Map feature-specific readiness into the workspace's initial loading steps. */
export function workspaceStartupSteps({ context, navigation, routes, plates, charts, terrain, obstructions, mapIdle }: {
  context: WorkspaceReadContext | undefined;
  navigation: Pick<ReturnType<typeof useNavigationData>, 'loadState' | 'loading' | 'issues' | 'airways'> & {
    enabled: boolean; visibility: LayerVisibility;
  };
  routes: { enabled: boolean; hasEntries: boolean; status: RouteLoadStatus };
  plates: { enabled: boolean; snapshot: Pick<PlatesSnapshot, 'mapSelection' | 'mapImage' | 'mapRestoreError'> };
  charts: { count: number; state: ChartCacheState };
  terrain: { enabled: boolean; state: TerrainStatus['state'] };
  obstructions: { enabled: boolean; state: ObstructionStatus['state'] };
  mapIdle: boolean;
}): StartupStep[] {
  const steps: StartupStep[] = [{ label: 'Workspace', state: context ? 'ready' : 'loading' }];
  if (!context) return steps;
  const { visibility } = navigation;
  if (navigation.enabled && Object.values(visibility).some(Boolean)) {
    const limited = navigation.issues.length > 0 || Object.entries(navigation.loadState).some(([id, state]) =>
      visibility[id as NavigationLayerId] && (state === 'error' || state === 'partial')) ||
      (visibility.fixes && !!context.routing.airways && !navigation.airways);
    steps.push({ label: 'Navigation', state: navigation.loading ? 'loading' : limited ? 'limited' : 'ready' });
  }
  if (routes.enabled && routes.hasEntries) steps.push({ label: 'Routes',
    state: routes.status === 'loading' ? 'loading' : routes.status === 'error' ? 'unavailable'
      : routes.status === 'partial' ? 'limited' : 'ready' });
  if (plates.enabled && plates.snapshot.mapSelection) steps.push({ label: 'Approach plate',
    state: plates.snapshot.mapImage ? 'ready' : plates.snapshot.mapRestoreError ? 'unavailable' : 'loading' });
  if (charts.count > 0) steps.push({ label: 'Charts',
    state: charts.state === 'preparing' ? 'loading' : charts.state === 'unavailable' ? 'unavailable'
      : mapIdle ? 'ready' : 'rendering' });
  for (const [label, enabled, state] of [
    ['Terrain', terrain.enabled, terrain.state], ['Obstructions', obstructions.enabled, obstructions.state],
  ] as const) {
    if (enabled) steps.push({ label, state: state === 'error' ? 'unavailable'
      : state === 'zoom' || state === 'idle' && mapIdle ? 'not-needed' : state === 'idle' ? 'waiting' : state });
  }
  steps.push({ label: 'Map', state: mapIdle && !steps.some(startupStepPending) ? 'ready' : 'loading' });
  return steps;
}
