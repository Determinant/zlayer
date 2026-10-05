import { FeatureDetailsPanel } from './workspace/feature-details-panel';
import { EdgePanels } from './core/ui/edge-panels';
import { formatDate } from './core/format/time';
import { featureKey } from '@zlayer/domain';
import { routePointForFeature } from './layers/routes/selection';
import { lazy, Suspense, useEffect, useCallback, useMemo, useState } from 'react';

import type {
  Bounds,
  GeoPointFeature,
  NavigationData,
  NavigationLayerId,
} from '@zlayer/contracts';

import {
  SearchBox, useNavigationData, useNavigationSearch,
  resolveNavigationFeature,
  type LayerVisibility,
} from './layers/navigation';
import {
  chartCountForSelection, chartSelectionTitle, resolveChartSelection, NO_CHARTS, useChartCache,
} from './layers/charts';
import {
  RouteBar, useRouteController, DirectToDialog,
} from './layers/routes';
import { createWorkspaceLayers } from './workspace/products';
import { useNotamsApi } from './workspace/notams';
import { LayerMenu } from './shell/layer-menu';
import { SettingsLauncher } from './shell/settings-launcher';
import { useMapPreferences } from './workspace/use-map-preferences';
import { useMapView } from './shell/use-map-view';
import { useResourceWarning } from './shell/use-resource-warning';
import { NotificationBubbles } from './shell/notifications';
import { useNotifications } from './shell/use-notifications';
import { useOnline } from './core/use-online';
import { useCatalog } from './workspace/catalog/use-catalog';
import { useWorkspaceReadContext } from './workspace/use-workspace-read-context';
import type { ResourceErrorCode } from './core/data/errors';
import { visibleSavedBundles } from './offline/visible-bundles';
import { partitionRegionCoverage } from './offline/region-coverage';
import { LayerPanels } from './core/layers/panels';
import { LayerContributions } from './core/layers/contributions';
import { usePlugins } from './core/layers/use-plugins';
import { PANEL_LAYOUT } from './workspace/panel-layout';
import { useLayerSnapshot } from './core/layers/use-snapshot';
import { ErrorBoundary } from './core/layers/error-boundary';
import { MapEdgeTools } from './shell/map-edge-tools';
import { NearbyFeaturePicker } from './workspace/nearby-feature-picker';
import { StartupScreen } from './shell/startup-screen';
import { weatherStartupWork, workspaceStartupSteps } from './workspace/startup';
import { selectLayerStore } from './core/layers/store';
import { useWorkspaceSelection } from './workspace/use-selection';
import { useStartup } from './shell/use-startup';
import { useWorkspaceInputs } from './workspace/use-workspace-inputs';
import { workspaceNotifications } from './workspace/notifications';

const MapCanvas = lazy(() => import('./workspace/map/canvas'));

export function App() {
  const [mapIdle, setMapIdle] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const mapStartupFailed = useCallback(() => setMapFailed(true), []);
  const online = useOnline();
  const { catalog: browsingCatalog, cycles, selection, selectCycle, error: catalogError, cycleNotice } = useCatalog();
  const { context, bundles, ready: savedRegionsReady, error: regionError } = useWorkspaceReadContext(browsingCatalog);
  const workspaceCycleNotice = !browsingCatalog && context
    ? `Using saved FAA cycle ${formatDate(context.browsing.revision)}. ${catalogError
      ? 'Chart feed refresh failed; saved regions remain available.' : 'Checking for chart updates.'}`
    : cycleNotice;
  const [workspaceLayers] = useState(createWorkspaceLayers);
  const notamsApi = useNotamsApi(workspaceLayers.registry);
  const [mapPreferences, setMapPreferences] = useMapPreferences(workspaceLayers.plugins);
  const [mapView, setMapView] = useMapView();
  const plugins = usePlugins(workspaceLayers.plugins);
  const loaded = Object.fromEntries(plugins.controlsList.map(plugin => [plugin.id, plugin.loaded]));
  const { chartBase, chartOverlay, visibility: savedVisibility, fixDisplay } = mapPreferences;
  const visibility = useMemo(() => loaded.navigation ? savedVisibility : Object.fromEntries(
    Object.keys(savedVisibility).map(id => [id, false])) as LayerVisibility, [loaded.navigation, savedVisibility]);
  const metarEnabled = !!loaded.metar && mapPreferences.metarEnabled;
  const terrainEnabled = !!loaded.terrain && mapPreferences.terrainEnabled;
  const obstructionsEnabled = !!loaded.obstructions && mapPreferences.obstructionsEnabled;
  const mapContributions = useMemo(() => [...plugins.mapContributions, workspaceLayers.selectionContribution],
    [plugins.mapContributions, workspaceLayers]);
  const terrainStatus = useLayerSnapshot(workspaceLayers.terrain.status);
  const obstructionStatus = useLayerSnapshot(workspaceLayers.obstructions.status);
  const { metar: metarLayer, plates, ownship: ownshipLayer } = workspaceLayers;
  const metarSnapshot = useLayerSnapshot(metarLayer);
  const reportStatus = useLayerSnapshot(metarLayer.reportStatus);
  const awcStartupStore = useMemo(() => selectLayerStore(workspaceLayers.weatherAwc.controller,
    state => weatherStartupWork(state, online)), [workspaceLayers, online]);
  const awcStartup = useLayerSnapshot(awcStartupStore);
  const plateSnapshot = useLayerSnapshot(plates);
  const [viewport, setViewport] = useState<Bounds>();
  const visibleBundles = useMemo(() => visibleSavedBundles(bundles, viewport), [bundles, viewport]);
  const browsingVisible = useMemo(() => !viewport ||
    partitionRegionCoverage(bundles, viewport).some(part => !part.bundle), [bundles, viewport]);
  const [focusTarget, setFocusTarget] = useState<
    { feature: GeoPointFeature; nonce: number } | undefined
  >();
  const [query, setQuery] = useState('');
  const { warning, report, clear } = useResourceWarning(online);
  const reportChartError = useCallback((message: string, code?: ResourceErrorCode) => report('Chart unavailable', message, code), [report]);
  useEffect(() => {
    if (!loaded.navigation) setQuery('');
  }, [loaded.navigation]);

  const { data: navigationData, loadState, loading: navigationPending, issues: navigationIssues, airways } = useNavigationData(
    loaded.navigation ? context : undefined, visibility);
  const route = useRouteController({ catalog: context?.routing, enabled: !!loaded.routes,
    gps: ownshipLayer, directToEnabled: !!loaded.ownship });
  const routePreview = route.preview;
  const { metars } = metarSnapshot;
  const search = useNavigationSearch(loaded.navigation ? context : undefined, query, loaded.metar ? metars : undefined);
  const chartSelection = useMemo(() => loaded.charts ? resolveChartSelection(context?.charts ?? [], chartBase, chartOverlay) : NO_CHARTS,
    [loaded.charts, context?.charts, chartBase, chartOverlay]);
  const activeChartTitle = chartSelectionTitle(chartSelection);
  const activeChartCount = chartCountForSelection(
    context?.charts ?? [],
    chartSelection,
  );
  const {
    state: chartCacheState,
    retry: retryChartCache,
  } = useChartCache(context?.charts, reportChartError, !!loaded.charts);
  const renderedCharts = chartCacheState === 'ready' ? chartSelection : NO_CHARTS;
  const visibleFeatureCount = useMemo(
    () => countVisibleFeatures(navigationData, visibility),
    [navigationData, visibility],
  );
  const mapNavigationData = useMemo(
    () => ({ ...route.data, ...navigationData }),
    [navigationData, route.data],
  );

  const featureSelection = useWorkspaceSelection({ context, navigationData: mapNavigationData, routePlan: route.plan,
    registry: workspaceLayers.registry, plates: plateSnapshot, weather: metarSnapshot,
    navigationEnabled: !!loaded.navigation, weatherEnabled: !!loaded.metar });
  const { selected, selectFeature, openPlate, nearbyFeatures } = featureSelection;
  const fixContext = useMemo(() => ({
    fixDisplay, airways,
    priorityFixes: [
      ...(selected?.properties.kind === 'fix' ? [selected] : []),
      ...route.plan.waypoints.filter(waypoint => waypoint.layer === 'fixes').map(waypoint => waypoint.feature),
      ...(routePreview?.routes.find(route => route.key === routePreview.selectedKey)?.plan.waypoints ?? [])
        .filter(waypoint => waypoint.layer === 'fixes').map(waypoint => waypoint.feature),
    ],
  }), [fixDisplay, airways, selected, route.plan, routePreview]);

  const selectSearchResult = (feature: GeoPointFeature) => {
    selectFeature(feature);
    setFocusTarget({ feature, nonce: Date.now() });
    setQuery('');
  };

  const visibleNavigationIssues = navigationIssues.filter(issue => issue.regionId ?
    visibleBundles.some(bundle => bundle.plan.regionId === issue.regionId && bundle.catalog.revision === issue.revision) : browsingVisible);
  const resolveMapFeature = useCallback((feature: GeoPointFeature) => resolveNavigationFeature(feature, mapNavigationData), [mapNavigationData]);
  useWorkspaceInputs({ workspaceLayers, context, mapPreferences, setMapPreferences, loaded, clear, visibleBundles,
    charts: { selection: renderedCharts, chartSelection, chartCacheState, activeChartTitle, activeChartCount },
    navigation: { data: mapNavigationData, navigationData, visibility, fixContext,
      identification: featureSelection.identificationMap, loadState,
      inspectedCoordinate: selected?.properties.kind === 'coordinate' && !routePointForFeature(route.plan, selected) ? selected : undefined },
    routes: route.mapInput,
    selection: { resolveFeature: resolveMapFeature, onSelect: selectFeature,
      onChooseNearby: featureSelection.chooseNearby, onCloseNearby: featureSelection.closeNearby },
  });

  const startupSteps = workspaceStartupSteps({ context, mapIdle, plugins: plugins.controlsList,
    navigation: { enabled: !!loaded.navigation, visibility, loadState, loading: navigationPending, issues: navigationIssues, airways },
    routes: { enabled: !!loaded.routes, hasEntries: route.hasEntries, status: route.status },
    plates: { enabled: !!loaded.plates, snapshot: plateSnapshot },
    charts: { count: activeChartCount, state: chartCacheState },
    terrain: { enabled: terrainEnabled, state: terrainStatus.state },
    obstructions: { enabled: obstructionsEnabled, state: obstructionStatus.state },
    metar: { snapshot: metarSnapshot, reports: Object.values(reportStatus) },
    awc: awcStartup,
  });
  const startup = useStartup(startupSteps, mapFailed);
  const connectionFailures = useLayerSnapshot(workspaceLayers.registry.scopedConnections.failures);
  const notices = workspaceNotifications({ connectionFailures,
    pluginTitle: id => workspaceLayers.plugins.find(plugin => plugin.definition.id === id)?.definition.title ?? id,
    retryConnections: workspaceLayers.registry.scopedConnections.retryFailed,
    regionError, visibleNavigationIssues, workspaceCycleNotice, online,
    chartsSelected: !!chartSelection.base, chartCacheState, retryChartCache, feedIssues: browsingCatalog?.issues, warning,
  });
  const notifications = useNotifications(notices);
  if (catalogError && savedRegionsReady && !context) return <CatalogError message={catalogError} />;
  if (!context) return <StartupScreen steps={startup.steps} slow={startup.slow} />;

  return (
    <><fieldset className="workspace-startup-gate" role="presentation" disabled={!startup.complete}>
    <main className={`app-shell${loaded.routes ? '' : ' routes-unloaded'}`} inert={!startup.complete} aria-busy={!startup.complete}>
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/icon.svg" alt="ZLayer" />
          <img className="brand-logo" src="/logo.svg" alt="ZLayer" width="144" height="46" />
          <span className="brand-tagline">A modern, lightweight EFB. Layer by layer.</span>
        </div>

        {loaded.navigation && <SearchBox
          query={query}
          results={search.results}
          loading={search.loading}
          unavailable={search.unavailable}
          issues={search.issues}
          onQueryChange={setQuery}
          onSelect={selectSearchResult}
        />}

        <div className="topbar-meta">
          <SettingsLauncher catalog={context.browsing} cycles={cycles} selection={selection}
            onCycleChange={selectCycle} cycleNotice={workspaceCycleNotice}
            plugins={plugins.controlsList} onPluginChange={plugins.setLoaded} pluginError={plugins.error}
            notifications={notifications.notices} />
        </div>
      </header>

      {loaded.routes && <RouteBar {...route.barProps} catalog={context.routing}
        onIdentify={loaded.navigation ? featureSelection.identifyFeature : undefined}
        onOpenPlate={loaded.plates ? openPlate : undefined} />}

      <section className="workspace">
        <div className="map-stage">
          <ErrorBoundary onError={mapStartupFailed} fallback={error => <div className="map-runtime-error" role="alert">
            <span>Map unavailable: {error.message}</span>
            <button className="ui-button" type="button" onClick={() => window.location.reload()}>Reload app</button>
          </div>}>
            <Suspense fallback={<div className="map-loading">Starting WebGL map…</div>}>
              <MapCanvas
                contributions={mapContributions}
                orientation={ownshipLayer}
                {...(mapView ? { initialView: mapView } : {})}
                focusTarget={focusTarget}
                onViewportChange={setViewport}
                onViewChange={setMapView}
                onReady={() => clear('Map layer unavailable')}
                onIdleChange={startup.complete ? undefined : setMapIdle}
                onStartupFailure={mapStartupFailed}
                onError={(message, code) => report('Map layer unavailable', message, code)}
              />
            </Suspense>
          </ErrorBoundary>

          <LayerContributions contributions={plugins.overlays} />

          {nearbyFeatures && <NearbyFeaturePicker features={nearbyFeatures.features} point={nearbyFeatures.point} actions={nearbyFeatures.actions}
            onSelect={selectFeature} onClose={featureSelection.closeNearby} />}

          <LayerMenu controls={plugins.controls} footer={plugins.footer}
            visibleFeatureCount={visibleFeatureCount}
            activeCount={Object.values(visibility).filter(Boolean).length + (chartSelection.base ? 1 : 0) +
              (chartSelection.overlay ? 1 : 0) + (metarEnabled ? 1 : 0) + (terrainEnabled ? 1 : 0) + (obstructionsEnabled ? 1 : 0) + (loaded['weather-awc'] && mapPreferences.awcEnabled ? 1 : 0)} />
          <MapEdgeTools layout={PANEL_LAYOUT}>
            <LayerPanels panels={plugins.panels} layout={PANEL_LAYOUT} />
          </MapEdgeTools>

          <NotificationBubbles notices={notifications.visible} onDismiss={notifications.dismiss} />

          <EdgePanels side="right" active={featureSelection.activeSidePanel} onActiveChange={featureSelection.setActiveSidePanel} className="side-panels">
            {loaded.navigation && selected && (
              <FeatureDetailsPanel
                key={featureKey(selected)}
                feature={featureSelection.feature ?? selected}
                catalog={context}
                metarClient={metarLayer.client}
                notamsApi={notamsApi}
                onWeatherStatus={metarLayer.setReportStatus}
                features={{ routes: !!loaded.routes, weather: !!loaded.metar, terrain: !!loaded.terrain, plates: !!loaded.plates }}
                procedureResource={featureSelection.catalog?.procedures}
                editionUnavailable={!featureSelection.catalog}
                identification={featureSelection.identification}
                onIdentificationChange={featureSelection.setIdentificationOpen}
                savedSupplement={featureSelection.savedSupplement}
                revision={featureSelection.catalog?.revision ?? selected.properties.dataRevision ?? context.browsing.revision}
                route={{ ...route.featureRoute, pointId: featureSelection.routePointId, onIdentify: featureSelection.identifyFeature }}
                onClose={() => selectFeature(undefined)}
                onOpenProcedure={openPlate}
              />
            )}

            <LayerPanels panels={plugins.panels} layout={PANEL_LAYOUT} />
          </EdgePanels>
        </div>
      </section>
      {loaded.routes && loaded.ownship && <DirectToDialog confirmation={route.confirmation} />}
    </main></fieldset>
    {!startup.complete && <StartupScreen steps={startup.steps} slow={startup.slow} onContinue={startup.finish} />}</>
  );
}

function countVisibleFeatures(
  navigationData: NavigationData,
  visibility: LayerVisibility,
): number {
  return Object.entries(navigationData).reduce(
    (count, [id, collection]) =>
      count + (visibility[id as NavigationLayerId] ? (collection?.features.length ?? 0) : 0),
    0,
  );
}

function CatalogError({ message }: { message: string }) {
  return (
    <main className="launch-state">
      <img className="brand-mark" src="/icon.svg" alt="ZLayer" />
      <h1>Chart feed unavailable</h1>
      <p>{message}</p>
      <code>charts.tedyin.com</code>
    </main>
  );
}
