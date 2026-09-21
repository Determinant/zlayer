import { FeatureDetailsPanel } from './workspace/feature-details-panel';
import { EdgePanels } from './core/ui/edge-panels';
import { formatDate } from './core/format/time';
import { featureKey, restoreRouteCoordinate } from '@zlayer/domain';
import { restoreApproachSelection, routePointForFeature, routePointKeys } from './layers/routes/selection';
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
import { FlightCategoryLegend, featureWithMetar } from './layers/metar-taf';
import {
  chartCountForSelection, chartSelectionTitle, resolveChartSelection, NO_CHARTS, useChartCache,
} from './layers/charts';
import {
  RouteBar, useRoutePlan, useRouteDraft, useDirectTo, DirectToDialog, appendRouteText, EMPTY_ROUTE_DRAFT,
  insertRouteFeature, insertRouteTextBefore, moveRouteEntry, removeRouteEntry,
  replaceRouteFeature, replaceRouteText, setRouteApproach, setRouteDeparture, type RouteMapPreview,
} from './layers/routes';
import { createWorkspaceLayers } from './workspace/products';
import { LayerMenu } from './shell/layer-menu';
import { SettingsLauncher } from './shell/settings-launcher';
import { useMapPreferences } from './shell/use-map-preferences';
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
import { useLayerSnapshot } from './core/layers/use-snapshot';
import { ErrorBoundary } from './core/layers/error-boundary';
import { TerrainLegend, type TerrainStatus } from './layers/terrain';
import type { ObstructionStatus } from './layers/obstructions';
import { OwnshipStatus } from './layers/ownship';
import { AhrsTool } from './layers/ahrs';
import { RulerTool } from './layers/ruler';
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
  const { chartBase, chartOverlay, visibility, fixDisplay, metarEnabled, terrainEnabled, terrainCoverage, obstructionsEnabled, terrainAltitude, ownshipEnabled } = mapPreferences;
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus>({ state: 'idle', interval: 1000 });
  const [obstructionStatus, setObstructionStatus] = useState<ObstructionStatus>({ state: 'idle' });
  const [workspaceLayers] = useState(createWorkspaceLayers);
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
  const routePreview = approachPreview ?? recommendations;

  const { data: navigationData, loadState, loading: navigationPending, issues: navigationIssues, airways } = useNavigationData(context, visibility);
  const route = useRoutePlan(
    context?.routing,
    routeDraft,
    setRouteDraft,
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
  const { metars, state: metarState, weatherAirportCount } = metarSnapshot;
  const search = useNavigationSearch(context, query, metars);
  const chartSelection = useMemo(() => resolveChartSelection(context?.charts ?? [], chartBase, chartOverlay),
    [context?.charts, chartBase, chartOverlay]);
  const activeChartTitle = chartSelectionTitle(chartSelection);
  const activeChartCount = chartCountForSelection(
    context?.charts ?? [],
    chartSelection,
  );
  const {
    state: chartCacheState,
    retry: retryChartCache,
  } = useChartCache(context?.charts, reportChartError);
  const renderedCharts = chartCacheState === 'ready' ? chartSelection : NO_CHARTS;
  const visibleFeatureCount = useMemo(
    () => countVisibleFeatures(navigationData, visibility),
    [navigationData, visibility],
  );
  const mapNavigationData = useMemo(
    () => ({ ...route.data, ...navigationData }),
    [navigationData, route.data],
  );

  const selectFeature = (feature: GeoPointFeature | undefined, routePointId?: string) => {
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
  };
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
    () => selectedReference ? featureWithMetar(selectedReference, metarSnapshot) : undefined,
    [selectedReference, metars],
  );
  // GPS coordinates have no published edition. Follow the current regional
  // context so a restored point adopts refreshed navigation references too.
  const selectedReadContext = selected?.properties.kind === 'coordinate' ? context : selectionContext?.context;
  const selectedCatalog = selectedReadContext && selectedWithWeather
    ? catalogForFeature(selectedReadContext, selectedWithWeather) : undefined;
  const identification = useNavaidIdentification(identificationOpen ? selected : undefined, selectedCatalog);
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

  const dataPending = navigationPending || route.status === 'loading' ||
    (!!mapSelection && !mappedPlate && !mapRestoreError) ||
    (activeChartCount > 0 && chartCacheState === 'preparing') ||
    (terrainEnabled && terrainStatus.state === 'loading') || (obstructionsEnabled && obstructionStatus.state === 'loading');
  const startup = useStartup(!!context && !dataPending && mapIdle, mapFailed);
  const startupMessage = !context ? 'Opening your workspace…' : dataPending ? 'Loading your map data…'
    : !mapIdle ? 'Preparing your map…' : 'Finishing up…';
  if (catalogError && !context) return <CatalogError message={catalogError} />;
  if (!context) return <StartupScreen message={startupMessage} slow={startup.slow} />;
  const savedEditions = [...new Set(visibleBundles.map(bundle => bundle.catalog.revision))];
  const visibleNavigationIssues = navigationIssues.filter(issue => issue.regionId ?
    visibleBundles.some(bundle => bundle.plan.regionId === issue.regionId && bundle.catalog.revision === issue.revision) : browsingVisible);
  const savedEditionDetails = `Saved coverage in this view: ${visibleBundles.map(bundle =>
    `${bundle.plan.title} · ${formatDate(bundle.catalog.revision)}`).join(', ')}. Saved regions override browsing. Route data: ${formatDate(context.routing.revision)} (saved).`;

  const selectSearchResult = (feature: GeoPointFeature) => {
    selectFeature(feature);
    setFocusTarget({ feature, nonce: Date.now() });
    setQuery('');
  };
  const insertRouteWaypoint = (afterEntryId: string, feature: GeoPointFeature) => {
    setRouteDraft((current) => insertRouteFeature(current, afterEntryId, feature));
  };
  const replaceRouteWaypoint = (entryId: string, feature: GeoPointFeature) => {
    setRouteDraft((current) => replaceRouteFeature(current, entryId, feature));
  };
  const removeRouteWaypoint = (entryId: string) => {
    setRouteDraft((current) => removeRouteEntry(current, entryId));
  };

  return (
    <><fieldset className="workspace-startup-gate" role="presentation" disabled={!startup.complete}>
    <main className="app-shell" inert={!startup.complete} aria-busy={!startup.complete}>
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/icon.svg" alt="ZLayer" />
          <img className="brand-logo" src="/logo.svg" alt="ZLayer" width="144" height="46" />
          <span className="brand-tagline">A modern, lightweight EFB. Layer by layer.</span>
        </div>

        <SearchBox
          query={query}
          results={search.results}
          loading={search.loading}
          unavailable={search.unavailable}
          issues={search.issues}
          onQueryChange={setQuery}
          onSelect={selectSearchResult}
        />

        <div className="topbar-meta">
          <SettingsLauncher catalog={browsingCatalog!} cycles={cycles} selection={selection}
            onCycleChange={selectCycle} cycleNotice={cycleNotice} />
        </div>
      </header>

      <RouteBar
        plan={route.plan}
        navigationData={route.data}
        status={route.status}
        catalog={context.routing}
        onUseRoute={setRouteDraft}
        onDirectTo={directTo}
        onApproachChange={(entry, approach) => setRouteDraft(current => setRouteApproach(current, entry, approach))}
        onDepartureChange={(entry, departure) => setRouteDraft(current => setRouteDeparture(current, entry, departure))}
        onOpenPlate={selection => { plates.open(selection); setActiveSidePanel('plate'); }}
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
      />

      <section className="workspace">
        <div className="map-stage">
          <ErrorBoundary onError={mapStartupFailed} fallback={error => <div className="map-runtime-error" role="alert">
            <span>Map unavailable: {error.message}</span>
            <button type="button" onClick={() => window.location.reload()}>Reload app</button>
          </div>}>
            <Suspense fallback={<div className="map-loading">Starting WebGL map…</div>}>
              <MapCanvas
                catalog={context}
                chartSelection={renderedCharts}
                visibility={visibility}
                fixContext={fixContext}
                data={mapNavigationData}
                route={route.plan}
                routePreview={routePreview}
                identification={identificationMap}
                inspectedCoordinate={selected?.properties.kind === 'coordinate' && !routePointForFeature(route.plan, selected)
                  ? selected : undefined}
                {...(mapView ? { initialView: mapView } : {})}
                routeFocusNonce={routeFocusNonce}
                focusTarget={focusTarget}
                onSelect={selectFeature}
                onChooseNearby={(features, point) => setNearbyFeatures({ features, point })}
                onViewportChange={setViewport}
                onViewChange={setMapView}
                metarLayer={metarLayer}
                platesLayer={plates}
                rulerLayer={workspaceLayers.ruler}
                metarEnabled={metarEnabled}
                ownshipLayer={ownshipLayer}
                ownshipEnabled={ownshipEnabled}
                terrainEnabled={terrainEnabled}
                terrainCoverage={terrainCoverage}
                obstructionsEnabled={obstructionsEnabled}
                terrainAltitude={terrainAltitude}
                onTerrainStatus={setTerrainStatus}
                onObstructionStatus={setObstructionStatus}
                onRouteLegInsert={insertRouteWaypoint}
                onRouteWaypointReplace={replaceRouteWaypoint}
                onRouteWaypointRemove={removeRouteWaypoint}
                onReady={() => clear('Map layer unavailable')}
                onIdleChange={startup.complete ? undefined : setMapIdle}
                onStartupFailure={mapStartupFailed}
                onError={(message, code) => report('Map layer unavailable', message, code)}
              />
            </Suspense>
          </ErrorBoundary>

          <plates.MapControl />
          <RulerTool layer={workspaceLayers.ruler} revision={context.browsing.revision} />

          {nearbyFeatures && <NearbyFeaturePicker features={nearbyFeatures.features} point={nearbyFeatures.point}
            onSelect={selectFeature} onClose={() => setNearbyFeatures(undefined)} />}

          <LayerMenu
            catalog={context}
            chartSelection={chartSelection}
            visibility={visibility}
            fixDisplay={fixDisplay}
            onFixDisplayChange={fixDisplay => setMapPreferences(current => ({ ...current, fixDisplay }))}
            navigationData={navigationData}
            loadState={loadState}
            visibleFeatureCount={visibleFeatureCount}
            metarEnabled={metarEnabled}
            metarStatus={metarState.status}
            metarObservedAt={metarState.observedAt}
            weatherAirportCount={weatherAirportCount}
            terrainEnabled={terrainEnabled}
            terrainCoverage={terrainCoverage}
            onTerrainCoverageChange={terrainCoverage => setMapPreferences(current => ({ ...current, terrainCoverage }))}
            terrainStatus={terrainStatus}
            onTerrainVisibilityChange={() => setMapPreferences(current => ({ ...current, terrainEnabled: !current.terrainEnabled }))}
            obstructionsEnabled={obstructionsEnabled}
            obstructionStatus={obstructionStatus}
            onObstructionVisibilityChange={() => setMapPreferences(current => ({ ...current, obstructionsEnabled: !current.obstructionsEnabled }))}
            onChartBaseChange={(chartBase) => {
              clear('Chart unavailable');
              setMapPreferences(current => ({ ...current, chartBase }));
            }}
            onChartOverlayChange={(chartOverlay) => {
              clear('Chart unavailable');
              setMapPreferences(current => ({ ...current, chartOverlay }));
            }}
            onVisibilityChange={(layerId) =>
              setMapPreferences(current => ({ ...current,
                visibility: { ...current.visibility, [layerId]: !current.visibility[layerId] },
              }))
            }
            onMetarVisibilityChange={() => setMapPreferences(current => ({ ...current, metarEnabled: !current.metarEnabled }))}
          />

          <MapEdgeTools charts={<div className="map-badge" aria-label="Chart status">
            <span>
              {chartSelection.base
                ? chartCacheState === 'preparing'
                  ? 'CACHE'
                  : chartCacheState === 'ready' ? 'MBTILES' : 'OFFLINE'
                : 'WEBGL'}
            </span>
            <strong>
              {chartSelection.base && chartCacheState === 'preparing'
                ? 'Preparing whole-file chart cache…'
                : chartSelection.base && chartCacheState === 'unavailable'
                ? 'Whole-file chart cache unavailable'
                : chartSelection.base
                ? `${activeChartTitle} · ${activeChartCount} charts`
                : 'Base map'}
            </strong>
            {savedEditions.length > 0 && <div className="saved-editions" role="status"
              title={savedEditionDetails} aria-label={savedEditionDetails}>
              {savedEditions.map(revision => <div key={revision}>
                {visibleBundles.filter(bundle => bundle.catalog.revision === revision).map(bundle =>
                  OFFLINE_REGIONS.find(region => region.id === bundle.plan.regionId)?.title ?? bundle.plan.title
                ).join(', ')} · Saved · <time dateTime={revision}>{formatDate(revision)}</time>
              </div>)}
              {savedEditions.length > 1 && <div>Routes · <time dateTime={context.routing.revision}>{formatDate(context.routing.revision)}</time></div>}
            </div>}
          </div>}
            gps={<OwnshipStatus layer={ownshipLayer} enabled={ownshipEnabled}
              onToggle={() => setMapPreferences(current => ({ ...current, ownshipEnabled: !current.ownshipEnabled }))} />}
            ahrs={{ render: visible => <AhrsTool layer={workspaceLayers.ahrs} route={route.plan} revision={context.browsing.revision} visible={visible} />,
              stop: workspaceLayers.ahrs.stop }}
            terrain={<TerrainLegend status={terrainStatus} altitude={terrainAltitude} enabled={terrainEnabled}
                onToggle={() => setMapPreferences(current => ({ ...current, terrainEnabled: !current.terrainEnabled }))}
                coverage={terrainCoverage} onCoverageChange={terrainCoverage => setMapPreferences(current => ({ ...current, terrainCoverage }))}
                onAltitudeChange={terrainAltitude => setMapPreferences(current => ({ ...current, terrainAltitude }))} />}
          >
            <LayerPanels layers={workspaceLayers.panels} />
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

          {metarEnabled && weatherAirportCount > 0 && (
            <FlightCategoryLegend observedAt={metarState.observedAt} />
          )}

          <EdgePanels side="right" active={activeSidePanel} onActiveChange={setActiveSidePanel} className="side-panels">
            {selected && (
              <FeatureDetailsPanel
                key={featureKey(selected)}
                feature={selectedWithWeather ?? selected}
                catalog={context}
                metarClient={metarLayer.client}
                procedureResource={selectedCatalog?.procedures}
                editionUnavailable={!selectedCatalog}
                identification={identificationOpen ? identification : undefined}
                onIdentificationChange={setIdentificationOpen}
                savedSupplement={supplementForFeature(selectedReadContext!, selectedWithWeather ?? selected)}
                revision={selectedCatalog?.revision ?? selected.properties.dataRevision ?? context.browsing.revision}
                route={{ plan: route.plan, pointId: selectionContext?.routePointId, update: setRouteDraft, onDirectTo: directTo }}
                onClose={() => selectFeature(undefined)}
                onOpenProcedure={selection => { plates.open(selection); setActiveSidePanel('plate'); }}
              />
            )}

            <LayerPanels layers={workspaceLayers.panels} />
          </EdgePanels>
        </div>
      </section>
      <DirectToDialog confirmation={directToConfirmation} />
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
