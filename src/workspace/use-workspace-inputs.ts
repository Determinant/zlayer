import { useLayoutEffect, useMemo } from 'react';
import type { NavigationLayerId } from '@zlayer/contracts';
import type { createWorkspaceLayers } from './products';
import type { useMapPreferences } from './use-map-preferences';
import type { useResourceWarning } from '../shell/use-resource-warning';
import type { WorkspaceReadContext } from './read-context';
import type { SavedBundle } from '../offline/bundle-repository';
import { OFFLINE_REGIONS } from '../offline/regions';
import { formatDate } from '../core/format/time';
import type { MapSelectionInput } from '../core/map/selection';

type Layers = ReturnType<typeof createWorkspaceLayers>;
type PreferenceState = ReturnType<typeof useMapPreferences<Layers['plugins']>>;
type Preferences = PreferenceState[0];
type ChartsInput = ReturnType<Layers['charts']['input']['require']>;
type NavigationInput = ReturnType<Layers['navigation']['input']['require']>;

type WorkspaceInputs = {
  workspaceLayers: Layers;
  context: WorkspaceReadContext | undefined;
  mapPreferences: Preferences;
  setMapPreferences: PreferenceState[1];
  loaded: Readonly<Record<string, boolean>>;
  clear: ReturnType<typeof useResourceWarning>['clear'];
  visibleBundles: readonly SavedBundle[];
  charts: Pick<ChartsInput, 'selection' | 'chartSelection' | 'chartCacheState' | 'activeChartTitle' | 'activeChartCount'>;
  navigation: Pick<NavigationInput, 'data' | 'navigationData' | 'visibility' | 'fixContext' | 'identification' | 'loadState' | 'inspectedCoordinate' | 'focusedFeature'>;
  routes: ReturnType<Layers['routes']['input']['require']>;
  selection: MapSelectionInput;
};

/** Explicit product bindings publish committed state before map contributions attach. */
export function useWorkspaceInputs({ workspaceLayers, context, mapPreferences, setMapPreferences,
  loaded, clear, visibleBundles, charts, navigation, routes, selection }: WorkspaceInputs): void {
  const { terrainAltitude, terrainCoverage, fixDisplay } = mapPreferences;
  const savedEditions = useMemo(() => [...new Set(visibleBundles.map(bundle => bundle.catalog.revision))]
    .map(revision => ({ revision, title: visibleBundles.filter(bundle => bundle.catalog.revision === revision)
      .map(bundle => OFFLINE_REGIONS.find(region => region.id === bundle.plan.regionId)?.title ?? bundle.plan.title).join(', ') })), [visibleBundles]);
  const savedEditionDetails = `Saved coverage in this view: ${visibleBundles.map(bundle =>
    `${bundle.plan.title} · ${formatDate(bundle.catalog.revision)}`).join(', ')}. Saved regions override browsing. Route data: ${formatDate(context?.routing.revision ?? context?.browsing.revision ?? '')} (saved).`;
  const pluginActions = useMemo(() => ({
    ownship: { onToggle: () => setMapPreferences(current => ({ ...current, ownshipEnabled: !current.ownshipEnabled })) },
    terrain: {
      onToggle: () => setMapPreferences(current => ({ ...current, terrainEnabled: !current.terrainEnabled })),
      onAltitudeChange: (value: Preferences['terrainAltitude']) => setMapPreferences(current => ({ ...current, terrainAltitude: value })),
      onCoverageChange: (value: Preferences['terrainCoverage']) => setMapPreferences(current => ({ ...current, terrainCoverage: value })),
    },
    obstructions: { onToggle: () => setMapPreferences(current => ({ ...current, obstructionsEnabled: !current.obstructionsEnabled })) },
    charts: {
      onBaseChange: (value: Preferences['chartBase']) => { clear('Chart unavailable'); setMapPreferences(current => ({ ...current, chartBase: value })); },
      onOverlayChange: (value: Preferences['chartOverlay']) => { clear('Chart unavailable'); setMapPreferences(current => ({ ...current, chartOverlay: value })); },
    },
    navigation: {
      onFixDisplayChange: (value: Preferences['fixDisplay']) => setMapPreferences(current => ({ ...current, fixDisplay: value })),
      onVisibilityChange: (id: NavigationLayerId) => setMapPreferences(current => ({ ...current,
        visibility: { ...current.visibility, [id]: !current.visibility[id] } })),
    },
    glide: { change: (patch: Partial<Preferences>) => setMapPreferences(current => ({ ...current, ...patch })) },
    weather: { change: (patch: Partial<Preferences>) => setMapPreferences(current => ({ ...current, ...patch })) },
    metar: { onToggle: () => setMapPreferences(current => ({ ...current, metarEnabled: !current.metarEnabled })) },
  }), [setMapPreferences, clear]);
  useLayoutEffect(() => {
    if (!context) return;
    workspaceLayers.ownship.input.set({ enabled: !!loaded.ownship && mapPreferences.ownshipEnabled, ...pluginActions.ownship });
    workspaceLayers.ahrs.input.set({ revision: context.browsing.revision });
    workspaceLayers.ruler.input.set({ revision: context.browsing.revision });
    workspaceLayers.terrain.input.set({ enabled: !!loaded.terrain && mapPreferences.terrainEnabled, catalog: context,
      altitude: terrainAltitude, coverage: terrainCoverage, ...pluginActions.terrain });
    workspaceLayers.glide.input.set({ ...workspaceLayers.glide.preferences.select(mapPreferences), catalog: context,
      glideEnabled: !!loaded.glide && mapPreferences.glideEnabled, ...pluginActions.glide });
    workspaceLayers.obstructions.input.set({ enabled: !!loaded.obstructions && mapPreferences.obstructionsEnabled,
      ...pluginActions.obstructions });
    workspaceLayers.charts.input.set({ ...charts, catalog: context, savedEditionDetails,
      routingRevision: context.routing.revision, savedEditions, ...pluginActions.charts });
    workspaceLayers.navigation.input.set({ ...navigation, catalog: context, fixDisplay, ...pluginActions.navigation });
    workspaceLayers.metar.input.set({ catalog: context, enabled: !!loaded.metar && mapPreferences.metarEnabled,
      ...pluginActions.metar });
    workspaceLayers.weatherAwc.input.set({ ...workspaceLayers.weatherAwc.preferences.select(mapPreferences), revision: context.browsing.revision,
      awcEnabled: !!loaded['weather-awc'] && mapPreferences.awcEnabled, ...pluginActions.weather });
    workspaceLayers.routes.input.set(routes);
    workspaceLayers.selectionInput.set(selection);
  });
}
