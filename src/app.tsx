import { FeatureDetailsPanel } from './workspace/feature-details-panel';
import { EdgePanels } from './core/ui/edge-panels';
import { formatDate } from './core/format/time';
import { featureKey, restoreRouteCoordinate } from '@zlayer/domain';
import { restoreApproachSelection, routePointForFeature, routePointKeys } from './layers/routes/selection';
import { lazy, Suspense, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react';

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
import { featureWithMetar } from './layers/metar-taf';
import {
  chartCountForSelection, chartSelectionTitle, resolveChartSelection, NO_CHARTS, useChartCache,
} from './layers/charts';
import {
  RouteBar, useRoutePlan, useRouteDraft, useDirectTo, DirectToDialog, appendRouteText, EMPTY_ROUTE_DRAFT,
  insertRouteFeature, insertRouteTextBefore, moveRouteEntry, removeRouteEntry,
  replaceRouteFeature, replaceRouteText, setRouteApproach, setRouteDeparture, setRouteArrival, type RouteMapPreview,
} from './layers/routes';
import { createWorkspaceLayers } from './workspace/products';
import { LayerMenu } from './shell/layer-menu';
import { SettingsLauncher } from './shell/settings-launcher';
import { useMapPreferences } from './workspace/use-map-preferences';
import { useMapView } from './shell/use-map-view';
import { useResourceWarning } from './shell/use-resource-warning';
import { useOnline } from './core/use-online';
import { useCatalog } from './workspace/catalog/use-catalog';
import { useWorkspaceReadContext } from './workspace/use-workspace-read-context';
import { catalogForFeature, supplementForFeature, type WorkspaceReadContext } from './workspace/read-context';
import type { ResourceErrorCode } from './core/data/errors';
import { visibleSavedBundles } from './offline/visible-bundles';
import { retainActiveCatalog, retainActiveFiles } from './offline/active-catalogs';
import { retainedResourceUrls } from './offline/cache-cleanup';
import { OFFLINE_REGIONS } from './offline/regions';
import { navigationIssueMessages } from './layers/navigation/api';
import { partitionRegionCoverage } from './offline/region-coverage';
import { LayerPanels } from './core/layers/panels';
import { LayerContributions } from './core/layers/contributions';
import { usePlugins } from './core/layers/use-plugins';
import { PANEL_LAYOUT } from './workspace/panel-layout';
import { useLayerSnapshot } from './core/layers/use-snapshot';
import { ErrorBoundary } from './core/layers/error-boundary';
import { MapEdgeTools } from './shell/map-edge-tools';
import { NearbyFeaturePicker } from './workspace/nearby-feature-picker';
import type { NearbyFeature } from './workspace/feature-selection';
import { isGeoPointFeature } from '@zlayer/contracts';
import { usePersistentState } from './core/ui/use-persistent-state';
import { useNavaidIdentification } from './layers/navigation/use-navaid-identification';
import { StartupScreen } from './shell/startup-screen';
import { useStartup } from './shell/use-startup';

const MapCanvas = lazy(() => import('./workspace/map/canvas'));

export function App() {
  const [mapIdle, setMapIdle] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const mapStartupFailed = useCallback(() => setMapFailed(true), []);
  const online = useOnline();
  const { catalog: browsingCatalog, cycles, selection, selectCycle, error: catalogError, cycleNotice } = useCatalog();
  const { context, bundles, error: regionError } = useWorkspaceReadContext(browsingCatalog);
  const [mapPreferences, setMapPreferences] = useMapPreferences();
  const [mapView, setMapView] = useMapView();
  const [workspaceLayers] = useState(createWorkspaceLayers);
  const plugins = usePlugins(workspaceLayers.plugins);
  const loaded = Object.fromEntries(plugins.controlsList.map(plugin => [plugin.id, plugin.loaded]));
  const { chartBase, chartOverlay, visibility: savedVisibility, fixDisplay, terrainCoverage, terrainAltitude } = mapPreferences;
  const visibility = useMemo(() => loaded.navigation ? savedVisibility : Object.fromEntries(
    Object.keys(savedVisibility).map(id => [id, false])) as LayerVisibility, [loaded.navigation, savedVisibility]);
  const metarEnabled = !!loaded.metar && mapPreferences.metarEnabled;
  const terrainEnabled = !!loaded.terrain && mapPreferences.terrainEnabled;
  const obstructionsEnabled = !!loaded.obstructions && mapPreferences.obstructionsEnabled;
  const ownshipEnabled = !!loaded.ownship && mapPreferences.ownshipEnabled;
  const mapContributions = useMemo(() => [...plugins.mapContributions, workspaceLayers.selectionContribution],
    [plugins.mapContributions, workspaceLayers]);
  const terrainStatus = useLayerSnapshot(workspaceLayers.terrain.status);
  const obstructionStatus = useLayerSnapshot(workspaceLayers.obstructions.status);
  const { metar: metarLayer, plates, ownship: ownshipLayer } = workspaceLayers;
  const metarSnapshot = useLayerSnapshot(metarLayer);
  const { mapImage: mappedPlate, selection: plateSelection, mapSelection, mapImageRestored, mapRestoreError } = useLayerSnapshot(plates);
  const [selectionContext, setSelectionContext] = useState<{ feature: GeoPointFeature; context: WorkspaceReadContext; routePointId?: string }>();
  const [identificationOpen, setIdentificationOpen] = usePersistentState('identification-open', false,
    (value): value is boolean => typeof value === 'boolean');
  const [savedFeature, setSavedFeature] = usePersistentState<GeoPointFeature | null>('selected-feature', null,
    (value): value is GeoPointFeature | null => value === null || isGeoPointFeature(value));
  const [activeSidePanel, setActiveSidePanel] = usePersistentState<string | null>('side-panel',
    plateSelection ? 'plate' : savedFeature ? 'details' : null,
    (value): value is string | null => value === null || value === 'plate' || value === 'details');
  useEffect(() => {
    if ((activeSidePanel === 'plate' && !plateSelection) || (activeSidePanel === 'details' && !savedFeature)) setActiveSidePanel(null);
  }, [activeSidePanel, plateSelection, savedFeature, setActiveSidePanel]);
  const [savedRoutePointId, setSavedRoutePointId] = usePersistentState<string | null>('selected-route-entry', null,
    (value): value is string | null => value === null || typeof value === 'string' && value.length > 0);
  useEffect(() => {
    if (context && savedFeature && !selectionContext) setSelectionContext({ feature: restoreRouteCoordinate(savedFeature), context,
      ...(savedRoutePointId === null ? {} : { routePointId: savedRoutePointId }) });
  }, [context, savedFeature, savedRoutePointId, selectionContext]);
  const [nearbyFeatures, setNearbyFeatures] = useState<{ features: NearbyFeature[]; point: { x: number; y: number } }>();
  const selected = selectionContext?.feature;
  const [viewport, setViewport] = useState<Bounds>();
  const visibleBundles = useMemo(() => visibleSavedBundles(bundles, viewport), [bundles, viewport]);
  const browsingVisible = useMemo(() => !viewport ||
    partitionRegionCoverage(bundles, viewport).some(part => !part.bundle), [bundles, viewport]);
  const [focusTarget, setFocusTarget] = useState<
    { feature: GeoPointFeature; nonce: number } | undefined
  >();
  const [query, setQuery] = useState('');
  const { warning, report, clear, dismiss } = useResourceWarning(online);
  const reportChartError = useCallback((message: string, code?: ResourceErrorCode) => report('Chart unavailable', message, code), [report]);
  const [routeDraft, setRouteDraft] = useRouteDraft();
  const [routeFocusNonce, setRouteFocusNonce] = useState(0);
  const [recommendations, setRecommendations] = useState<RouteMapPreview>();
  const [approachPreview, setApproachPreview] = useState<RouteMapPreview>();
  const routePreview = loaded.routes ? approachPreview ?? recommendations : undefined;
  useEffect(() => {
    if (!loaded.routes) { setRecommendations(undefined); setApproachPreview(undefined); }
    if (!loaded.navigation) { setNearbyFeatures(undefined); setQuery(''); }
  }, [loaded.routes, loaded.navigation]);

  const { data: navigationData, loadState, loading: navigationPending, issues: navigationIssues, airways } = useNavigationData(
    loaded.navigation ? context : undefined, visibility);
  const route = useRoutePlan(
    loaded.routes ? context?.routing : undefined,
    loaded.routes ? routeDraft : EMPTY_ROUTE_DRAFT,
    loaded.routes ? setRouteDraft : undefined,
  );
  useEffect(() => {
    if (!selectionContext) return;
    const feature = restoreApproachSelection(route.plan, selectionContext.feature);
    if (feature === selectionContext.feature) return;
    const point = routePointForFeature(route.plan, selectionContext.feature, selectionContext.routePointId)!;
    const routePointId = routePointKeys(route.plan).get(point)!;
    setSelectionContext({ ...selectionContext, feature, routePointId });
    setSavedFeature(feature);
    setSavedRoutePointId(routePointId);
  }, [route.plan, selectionContext, setSavedFeature, setSavedRoutePointId]);
  const { action: directTo, confirmation: directToConfirmation } = useDirectTo(ownshipLayer, route.plan, setRouteDraft);
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

  const selectFeature = useCallback((feature: GeoPointFeature | undefined, routePointId?: string) => {
    setNearbyFeatures(undefined);
    setIdentificationOpen(false);
    setSavedRoutePointId(routePointId ?? null);
    if (!feature) {
      setActiveSidePanel(current => current === 'details' ? null : current);
      setSavedFeature(null); setSelectionContext(undefined); return;
    }
    if (context) {
      setActiveSidePanel('details');
      const resolved = resolveNavigationFeature(restoreRouteCoordinate(feature), mapNavigationData);
      setSavedFeature(resolved);
      setSelectionContext({ feature: resolved, context, ...(routePointId === undefined ? {} : { routePointId }) });
    }
  }, [context, mapNavigationData, setIdentificationOpen, setSavedRoutePointId, setActiveSidePanel, setSavedFeature]);
  const selectedReference = selected;
  useEffect(() => {
    if (!mappedPlate || mapImageRestored) return;
    setActiveSidePanel(null);
    setNearbyFeatures(undefined);
    setIdentificationOpen(false);
    setSavedRoutePointId(null);
    setSavedFeature(null);
    setSelectionContext(undefined);
  }, [mappedPlate, mapImageRestored]);
  const selectedWithWeather = useMemo(
    () => selectedReference && loaded.metar ? featureWithMetar(selectedReference, metarSnapshot) : selectedReference,
    [selectedReference, metars, loaded.metar],
  );
  // GPS coordinates have no published edition. Follow the current regional
  // context so a restored point adopts refreshed navigation references too.
  const selectedReadContext = selected?.properties.kind === 'coordinate' ? context : selectionContext?.context;
  const selectedCatalog = selectedReadContext && selectedWithWeather
    ? catalogForFeature(selectedReadContext, selectedWithWeather) : undefined;
  const identification = useNavaidIdentification(loaded.navigation && identificationOpen ? selected : undefined, selectedCatalog);
  const identificationMap = useMemo(() => identificationOpen && selected && identification.stations?.length
    ? { point: selected, stations: identification.stations } : undefined, [identificationOpen, selected, identification.stations]);
  useEffect(() => {
    if (!selectedCatalog || !selectedReadContext) return;
    const releaseCatalog = retainActiveCatalog(selectedCatalog);
    const bundle = selectedReadContext.bundles.find(bundle => bundle.catalog === selectedCatalog);
    const releaseFiles = bundle ? retainActiveFiles(retainedResourceUrls(bundle.plan)) : undefined;
    return () => { releaseCatalog(); releaseFiles?.(); };
  }, [selectedCatalog, selectedReadContext]);
  const fixContext = useMemo(() => ({
    fixDisplay, airways,
    priorityFixes: [
      ...(selectedReference?.properties.kind === 'fix' ? [selectedReference] : []),
      ...route.plan.waypoints.filter(waypoint => waypoint.layer === 'fixes').map(waypoint => waypoint.feature),
      ...(routePreview?.routes.find(route => route.key === routePreview.selectedKey)?.plan.waypoints ?? [])
        .filter(waypoint => waypoint.layer === 'fixes').map(waypoint => waypoint.feature),
    ],
  }), [fixDisplay, airways, selectedReference, route.plan, routePreview]);

  const selectSearchResult = (feature: GeoPointFeature) => {
    selectFeature(feature);
    setFocusTarget({ feature, nonce: Date.now() });
    setQuery('');
  };
  const insertRouteWaypoint = useCallback((afterEntryId: string, feature: GeoPointFeature) => {
    setRouteDraft((current) => insertRouteFeature(current, afterEntryId, feature));
  }, [setRouteDraft]);
  const replaceRouteWaypoint = useCallback((entryId: string, feature: GeoPointFeature) => {
    setRouteDraft((current) => replaceRouteFeature(current, entryId, feature));
  }, [setRouteDraft]);
  const removeRouteWaypoint = useCallback((entryId: string) => {
    setRouteDraft((current) => removeRouteEntry(current, entryId));
  }, [setRouteDraft]);

  const savedEditions = useMemo(() => [...new Set(visibleBundles.map(bundle => bundle.catalog.revision))]
    .map(revision => ({ revision, title: visibleBundles.filter(bundle => bundle.catalog.revision === revision)
      .map(bundle => OFFLINE_REGIONS.find(region => region.id === bundle.plan.regionId)?.title ?? bundle.plan.title).join(', ') })), [visibleBundles]);
  const visibleNavigationIssues = navigationIssues.filter(issue => issue.regionId ?
    visibleBundles.some(bundle => bundle.plan.regionId === issue.regionId && bundle.catalog.revision === issue.revision) : browsingVisible);
  const savedEditionDetails = `Saved coverage in this view: ${visibleBundles.map(bundle =>
    `${bundle.plan.title} · ${formatDate(bundle.catalog.revision)}`).join(', ')}. Saved regions override browsing. Route data: ${formatDate(context?.routing.revision ?? context?.browsing.revision ?? '')} (saved).`;
  const displayedRoutes = useMemo(() => routePreview?.routes.map(route => route.plan) ?? [route.plan], [route.plan, routePreview]);
  const pluginActions = useMemo(() => ({
    ownship: { onToggle: () => setMapPreferences(current => ({ ...current, ownshipEnabled: !current.ownshipEnabled })) },
    terrain: {
      onToggle: () => setMapPreferences(current => ({ ...current, terrainEnabled: !current.terrainEnabled })),
      onAltitudeChange: (value: typeof terrainAltitude) => setMapPreferences(current => ({ ...current, terrainAltitude: value })),
      onCoverageChange: (value: typeof terrainCoverage) => setMapPreferences(current => ({ ...current, terrainCoverage: value })),
    },
    obstructions: { onToggle: () => setMapPreferences(current => ({ ...current, obstructionsEnabled: !current.obstructionsEnabled })) },
    charts: {
      onBaseChange: (value: typeof chartBase) => { clear('Chart unavailable'); setMapPreferences(current => ({ ...current, chartBase: value })); },
      onOverlayChange: (value: typeof chartOverlay) => { clear('Chart unavailable'); setMapPreferences(current => ({ ...current, chartOverlay: value })); },
    },
    navigation: {
      onFixDisplayChange: (value: typeof fixDisplay) => setMapPreferences(current => ({ ...current, fixDisplay: value })),
      onVisibilityChange: (id: NavigationLayerId) => setMapPreferences(current => ({ ...current,
        visibility: { ...current.visibility, [id]: !current.visibility[id] } })),
    },
    metar: { onToggle: () => setMapPreferences(current => ({ ...current, metarEnabled: !current.metarEnabled })) },
    onChooseNearby: (features: NearbyFeature[], point: { x: number; y: number }) => setNearbyFeatures({ features, point }),
  }), [setMapPreferences, clear]);
  const resolveMapFeature = useCallback((feature: GeoPointFeature) => resolveNavigationFeature(feature, mapNavigationData), [mapNavigationData]);
  // Explicit workspace bindings publish committed state. Each map contribution
  // selects only the fields it consumes, so UI changes do not rebuild map data.
  useLayoutEffect(() => {
    if (!context) return;
    workspaceLayers.ownship.input.set({ enabled: ownshipEnabled, ...pluginActions.ownship });
    workspaceLayers.ahrs.input.set({ route: route.plan, revision: context.browsing.revision });
    workspaceLayers.ruler.input.set({ revision: context.browsing.revision });
    workspaceLayers.terrain.input.set({ enabled: terrainEnabled, routes: displayedRoutes, catalog: context,
      altitude: terrainAltitude, coverage: terrainCoverage,
      ...pluginActions.terrain });
    workspaceLayers.obstructions.input.set({ enabled: obstructionsEnabled, routes: displayedRoutes,
      ...pluginActions.obstructions });
    workspaceLayers.charts.input.set({ catalog: context, selection: renderedCharts, chartSelection, chartCacheState,
      activeChartTitle, activeChartCount, savedEditionDetails, routingRevision: context.routing.revision,
      savedEditions, ...pluginActions.charts });
    workspaceLayers.navigation.input.set({ catalog: context, data: mapNavigationData, navigationData, visibility, fixDisplay,
      fixContext, identification: identificationMap, loadState,
      inspectedCoordinate: selected?.properties.kind === 'coordinate' && !routePointForFeature(route.plan, selected) ? selected : undefined,
      ...pluginActions.navigation });
    workspaceLayers.metar.input.set({ catalog: context, airports: mapNavigationData.airports, enabled: metarEnabled,
      airportsVisible: visibility.airports,
      ...pluginActions.metar });
    workspaceLayers.routes.input.set({ route: route.plan, routePreview, focusNonce: routeFocusNonce,
      resolveFeature: resolveMapFeature, onSelect: selectFeature,
      onChooseNearby: pluginActions.onChooseNearby,
      onRouteLegInsert: insertRouteWaypoint, onRouteWaypointReplace: replaceRouteWaypoint, onRouteWaypointRemove: removeRouteWaypoint });
  });

  const dataPending = navigationPending || route.status === 'loading' ||
    (loaded.plates && !!mapSelection && !mappedPlate && !mapRestoreError) ||
    (activeChartCount > 0 && chartCacheState === 'preparing') ||
    (terrainEnabled && terrainStatus.state === 'loading') || (obstructionsEnabled && obstructionStatus.state === 'loading');
  const startup = useStartup(!!context && !dataPending && mapIdle, mapFailed);
  const startupMessage = !context ? 'Opening your workspace…' : dataPending ? 'Loading your map data…'
    : !mapIdle ? 'Preparing your map…' : 'Finishing up…';
  if (catalogError && !context) return <CatalogError message={catalogError} />;
  if (!context) return <StartupScreen message={startupMessage} slow={startup.slow} />;

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
          <SettingsLauncher catalog={browsingCatalog!} cycles={cycles} selection={selection}
            onCycleChange={selectCycle} cycleNotice={cycleNotice}
            plugins={plugins.controlsList} onPluginChange={plugins.setLoaded} pluginError={plugins.error} />
        </div>
      </header>

      {loaded.routes && <RouteBar
        plan={route.plan}
        navigationData={route.data}
        status={route.status}
        catalog={context.routing}
        onUseRoute={setRouteDraft}
        onDirectTo={loaded.ownship ? directTo : undefined}
        onApproachChange={(entry, approach) => setRouteDraft(current => setRouteApproach(current, entry, approach))}
        onDepartureChange={(entry, departure) => setRouteDraft(current => setRouteDeparture(current, entry, departure))}
        onArrivalChange={(entry, arrival) => setRouteDraft(current => setRouteArrival(current, entry, arrival))}
        onOpenPlate={loaded.plates ? selection => { plates.open(selection); setActiveSidePanel('plate'); } : undefined}
        onRecommendationPreview={setRecommendations}
        onApproachPreview={setApproachPreview}
        onAppendInput={(input) => setRouteDraft((current) => appendRouteText(current, input))}
        onInsertInput={(beforeEntryId, input) =>
          setRouteDraft((current) => insertRouteTextBefore(current, beforeEntryId, input))
        }
        onReplaceInput={(entryId, input) =>
          setRouteDraft((current) => replaceRouteText(current, entryId, input))
        }
        onRemoveEntry={(entryId) =>
          setRouteDraft((current) => removeRouteEntry(current, entryId))
        }
        onMoveEntry={(fromEntryId, toEntryId) =>
          setRouteDraft((current) =>
            moveRouteEntry(current, fromEntryId, toEntryId)
          )
        }
        onClear={() => setRouteDraft(EMPTY_ROUTE_DRAFT)}
        onFit={() => setRouteFocusNonce((current) => current + 1)}
      />}

      <section className="workspace">
        <div className="map-stage">
          <ErrorBoundary onError={mapStartupFailed} fallback={error => <div className="map-runtime-error" role="alert">
            <span>Map unavailable: {error.message}</span>
            <button type="button" onClick={() => window.location.reload()}>Reload app</button>
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

          {nearbyFeatures && <NearbyFeaturePicker features={nearbyFeatures.features} point={nearbyFeatures.point}
            onSelect={selectFeature} onClose={() => setNearbyFeatures(undefined)} />}

          <LayerMenu controls={plugins.controls} footer={plugins.footer}
            visibleFeatureCount={visibleFeatureCount}
            activeCount={Object.values(visibility).filter(Boolean).length + (chartSelection.base ? 1 : 0) +
              (chartSelection.overlay ? 1 : 0) + (metarEnabled ? 1 : 0) + (terrainEnabled ? 1 : 0) + (obstructionsEnabled ? 1 : 0)} />
          <MapEdgeTools layout={PANEL_LAYOUT}>
            <LayerPanels panels={plugins.panels} layout={PANEL_LAYOUT} />
          </MapEdgeTools>

          <div className="workspace-notices">
            {regionError && <div className="feed-status" role="status">{regionError}</div>}
            {visibleNavigationIssues.length > 0 && <div className="feed-status" role="status">
              {navigationIssueMessages(visibleNavigationIssues).join(' ')} Reconnect or repair the affected download.
            </div>}
            {cycleNotice && <div className="feed-status" role="status">{cycleNotice}</div>}
            {!online && <div className="offline-banner" role="status">Offline · Saved content remains available. Uncached areas are unavailable; weather may be stale.</div>}
            {chartSelection.base && chartCacheState === 'unavailable' && (
              <div className="map-runtime-error" role="alert">
                <strong>Charts are disabled</strong>
                <span>A controlling service worker is required for whole-file MBTiles caching.</span>
                <button type="button" onClick={retryChartCache}>Retry chart cache</button>
              </div>
            )}

            {browsingCatalog!.issues.length > 0 && (
              <div className="feed-status" role="status">
                {browsingCatalog!.issues.map(issue => <p key={issue.product}>{issue.product}: {issue.message}</p>)}
                <button type="button" onClick={() => window.location.reload()}>Reload feeds</button>
              </div>
            )}

            {warning && (
              <div className="map-runtime-error" role="alert">
                <strong>{warning.title}</strong>
                <span>{warning.message}</span>
                <button type="button" onClick={dismiss}>Dismiss warning</button>
              </div>
            )}
          </div>

          <EdgePanels side="right" active={activeSidePanel} onActiveChange={setActiveSidePanel} className="side-panels">
            {loaded.navigation && selected && (
              <FeatureDetailsPanel
                key={featureKey(selected)}
                feature={selectedWithWeather ?? selected}
                catalog={context}
                metarClient={metarLayer.client}
                features={{ routes: !!loaded.routes, weather: !!loaded.metar, terrain: !!loaded.terrain, plates: !!loaded.plates }}
                procedureResource={selectedCatalog?.procedures}
                editionUnavailable={!selectedCatalog}
                identification={identificationOpen ? identification : undefined}
                onIdentificationChange={setIdentificationOpen}
                savedSupplement={supplementForFeature(selectedReadContext!, selectedWithWeather ?? selected)}
                revision={selectedCatalog?.revision ?? selected.properties.dataRevision ?? context.browsing.revision}
                route={{ plan: route.plan, pointId: selectionContext?.routePointId, update: setRouteDraft, onDirectTo: loaded.ownship ? directTo : undefined }}
                onClose={() => selectFeature(undefined)}
                onOpenProcedure={selection => { plates.open(selection); setActiveSidePanel('plate'); }}
              />
            )}

            <LayerPanels panels={plugins.panels} layout={PANEL_LAYOUT} />
          </EdgePanels>
        </div>
      </section>
      {loaded.routes && loaded.ownship && <DirectToDialog confirmation={directToConfirmation} />}
    </main></fieldset>
    {!startup.complete && <StartupScreen message={startupMessage} slow={startup.slow} onContinue={startup.finish} />}</>
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
