import { FeatureDetailsPanel } from './workspace/feature-details-panel';
import { formatDate } from './core/format/time';
import { featureKey, restoreRouteCoordinate } from '@zlayer/domain';
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
  RouteBar, useRoutePlan, useRouteDraft, appendRouteText, EMPTY_ROUTE_DRAFT,
  insertRouteFeature, insertRouteTextBefore, moveRouteEntry, removeRouteEntry,
  replaceRouteFeature, replaceRouteText, type RouteRecommendationsMap,
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
import { MapEdgeTools } from './shell/map-edge-tools';
import { NearbyFeaturePicker } from './workspace/nearby-feature-picker';
import type { NearbyFeature } from './workspace/feature-selection';
import { isGeoPointFeature } from '@zlayer/contracts';
import { usePersistentState } from './core/ui/use-persistent-state';
import { useNavaidIdentification } from './layers/navigation/use-navaid-identification';

const MapCanvas = lazy(() => import('./workspace/map/canvas'));

export function App() {
  const online = useOnline();
  const { catalog: browsingCatalog, cycles, selection, selectCycle, error: catalogError, cycleNotice } = useCatalog();
  const { context, bundles, error: regionError } = useWorkspaceReadContext(browsingCatalog);
  const [mapPreferences, setMapPreferences] = useMapPreferences();
  const [mapView, setMapView] = useMapView();
  const { chartBase, chartOverlay, visibility, fixDisplay, metarEnabled, terrainEnabled, obstructionsEnabled, terrainAltitude, ownshipEnabled } = mapPreferences;
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus>({ state: 'idle', interval: 1000 });
  const [obstructionStatus, setObstructionStatus] = useState<ObstructionStatus>({ state: 'idle' });
  const [workspaceLayers] = useState(createWorkspaceLayers);
  const { metar: metarLayer, plates, ownship: ownshipLayer } = workspaceLayers;
  const metarSnapshot = useLayerSnapshot(metarLayer);
  const [selectionContext, setSelectionContext] = useState<{ feature: GeoPointFeature; context: WorkspaceReadContext; routePointId?: string }>();
  const [identificationOpen, setIdentificationOpen] = useState(false);
  const [savedFeature, setSavedFeature] = usePersistentState<GeoPointFeature | null>('selected-feature', null,
    (value): value is GeoPointFeature | null => value === null || isGeoPointFeature(value));
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
  const [recommendations, setRecommendations] = useState<RouteRecommendationsMap>();

  const { data: navigationData, loadState, issues: navigationIssues, airways } = useNavigationData(context, visibility);
  const route = useRoutePlan(
    context?.routing,
    routeDraft,
  );
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
    if (!feature) { setSavedFeature(null); setSelectionContext(undefined); return; }
    if (context) {
      const resolved = resolveNavigationFeature(restoreRouteCoordinate(feature), mapNavigationData);
      setSavedFeature(resolved);
      setSelectionContext({ feature: resolved, context, ...(routePointId === undefined ? {} : { routePointId }) });
    }
  };
  const selectedReference = selected;
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
      ...(recommendations?.routes.find(route => route.key === recommendations.selectedKey)?.plan.waypoints ?? [])
        .filter(waypoint => waypoint.layer === 'fixes').map(waypoint => waypoint.feature),
    ],
  }), [fixDisplay, airways, selectedReference, route.plan, recommendations]);

  if (catalogError && !context) return <CatalogError message={catalogError} />;
  if (!context) return <LaunchState />;
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
    <main className="app-shell">
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
        status={route.status}
        catalog={context.routing}
        onUseRoute={setRouteDraft}
        onRecommendationPreview={setRecommendations}
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
          <ErrorBoundary fallback={error => <div className="map-runtime-error" role="alert">
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
                recommendations={recommendations}
                identification={identificationMap}
                {...(mapView ? { initialView: mapView } : {})}
                routeFocusNonce={routeFocusNonce}
                focusTarget={focusTarget}
                onSelect={selectFeature}
                onChooseNearby={(features, point) => setNearbyFeatures({ features, point })}
                onViewportChange={setViewport}
                onViewChange={setMapView}
                metarLayer={metarLayer}
                metarEnabled={metarEnabled}
                ownshipLayer={ownshipLayer}
                ownshipEnabled={ownshipEnabled}
                terrainEnabled={terrainEnabled}
                obstructionsEnabled={obstructionsEnabled}
                terrainAltitude={terrainAltitude}
                onTerrainStatus={setTerrainStatus}
                onObstructionStatus={setObstructionStatus}
                onRouteLegInsert={insertRouteWaypoint}
                onRouteWaypointReplace={replaceRouteWaypoint}
                onRouteWaypointRemove={removeRouteWaypoint}
                onReady={() => clear('Map layer unavailable')}
                onError={(message, code) => report('Map layer unavailable', message, code)}
              />
            </Suspense>
          </ErrorBoundary>

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
            terrain={terrainEnabled && terrainStatus.state !== 'idle' &&
              <TerrainLegend status={terrainStatus} altitude={terrainAltitude}
                onAltitudeChange={terrainAltitude => setMapPreferences(current => ({ ...current, terrainAltitude }))} />}
          />

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

          {selected && (
            <FeatureDetailsPanel
              key={featureKey(selected)}
              feature={selectedWithWeather ?? selected}
              metarClient={metarLayer.client}
              procedureResource={selectedCatalog?.procedures}
              editionUnavailable={!selectedCatalog}
              identification={identificationOpen ? identification : undefined}
              onIdentificationChange={setIdentificationOpen}
              savedSupplement={supplementForFeature(selectedReadContext!, selectedWithWeather ?? selected)}
              revision={selectedCatalog?.revision ?? selected.properties.dataRevision ?? context.browsing.revision}
              route={{ plan: route.plan, pointId: selectionContext?.routePointId, update: setRouteDraft }}
              onClose={() => selectFeature(undefined)}
              onOpenProcedure={plates.open}
            />
          )}

          <LayerPanels layers={workspaceLayers.panels} />
        </div>
      </section>
    </main>
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

function LaunchState() {
  return (
    <main className="launch-state">
      <img className="brand-mark is-loading" src="/icon.svg" alt="ZLayer" />
      <p>Opening chart workspace…</p>
    </main>
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
