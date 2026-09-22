import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isGeoPointFeature, type GeoPointFeature, type NavigationData } from '@zlayer/contracts';
import { restoreRouteCoordinate, type RoutePlan } from '@zlayer/domain';
import { PluginScope, type PluginRegistry } from '../core/layers/bridge';
import type { NearbyFeature } from '../core/map/selection';
import { usePersistentState } from '../core/ui/use-persistent-state';
import { featureWithMetar, type MetarLayerSnapshot } from '../layers/metar-taf';
import { resolveNavigationFeature } from '../layers/navigation';
import { useNavaidIdentification } from '../layers/navigation/use-navaid-identification';
import type { ProcedureSelection } from '../layers/plates/data';
import type { PlatesSnapshot } from '../layers/plates/layer';
import { restoreApproachSelection, routePointForFeature, routePointKeys } from '../layers/routes/selection';
import { retainActiveCatalog, retainActiveFiles } from '../offline/active-catalogs';
import { retainedResourceUrls } from '../offline/cache-cleanup';
import type { WorkspacePluginApis } from './plugin-apis';
import { catalogForFeature, supplementForFeature, type WorkspaceReadContext } from './read-context';

/** Coordinate selection, its source edition and the right-hand panels together. */
export function useWorkspaceSelection({ context, navigationData, routePlan, registry, plates, weather,
  navigationEnabled, weatherEnabled }: {
  context: WorkspaceReadContext | undefined;
  navigationData: NavigationData;
  routePlan: RoutePlan;
  registry: PluginRegistry<WorkspacePluginApis>;
  plates: Pick<PlatesSnapshot, 'selection' | 'mapImage' | 'mapImageRestored'>;
  weather: MetarLayerSnapshot;
  navigationEnabled: boolean;
  weatherEnabled: boolean;
}) {
  const [selectionContext, setSelectionContext] = useState<{ feature: GeoPointFeature; context: WorkspaceReadContext; routePointId?: string }>();
  const [identificationOpen, setIdentificationOpen] = usePersistentState('identification-open', false,
    (value): value is boolean => typeof value === 'boolean');
  const [savedFeature, setSavedFeature] = usePersistentState<GeoPointFeature | null>('selected-feature', null,
    (value): value is GeoPointFeature | null => value === null || isGeoPointFeature(value));
  const [activeSidePanel, setActiveSidePanel] = usePersistentState<string | null>('side-panel',
    plates.selection ? 'plate' : savedFeature ? 'details' : null,
    (value): value is string | null => value === null || value === 'plate' || value === 'details');
  useEffect(() => {
    if ((activeSidePanel === 'plate' && !plates.selection) || (activeSidePanel === 'details' && !savedFeature)) setActiveSidePanel(null);
  }, [activeSidePanel, plates.selection, savedFeature, setActiveSidePanel]);
  const pluginAccess = useRef<ReturnType<typeof registry.forScope>>(undefined);
  useEffect(() => {
    const scope = new PluginScope();
    const bridge = registry.forScope(scope);
    pluginAccess.current = bridge;
    bridge.watch('plates', (api, connection) => {
      if (api) connection.listen(api.opened, () => setActiveSidePanel('plate'));
    });
    return () => { pluginAccess.current = undefined; scope.dispose(); };
  }, [registry, setActiveSidePanel]);
  const openPlate = useCallback((selection: ProcedureSelection) => {
    pluginAccess.current?.get('plates')?.open(selection);
  }, []);
  const [savedRoutePointId, setSavedRoutePointId] = usePersistentState<string | null>('selected-route-entry', null,
    (value): value is string | null => value === null || typeof value === 'string' && value.length > 0);
  useEffect(() => {
    if (context && savedFeature && !selectionContext) setSelectionContext({ feature: restoreRouteCoordinate(savedFeature), context,
      ...(savedRoutePointId === null ? {} : { routePointId: savedRoutePointId }) });
  }, [context, savedFeature, savedRoutePointId, selectionContext]);
  const [nearbyFeatures, setNearbyFeatures] = useState<{ features: NearbyFeature[]; point: { x: number; y: number } }>();
  useEffect(() => {
    if (!navigationEnabled) setNearbyFeatures(undefined);
  }, [navigationEnabled]);
  useEffect(() => {
    if (!selectionContext) return;
    const feature = restoreApproachSelection(routePlan, selectionContext.feature);
    if (feature === selectionContext.feature) return;
    const point = routePointForFeature(routePlan, selectionContext.feature, selectionContext.routePointId)!;
    const routePointId = routePointKeys(routePlan).get(point)!;
    setSelectionContext({ ...selectionContext, feature, routePointId });
    setSavedFeature(feature);
    setSavedRoutePointId(routePointId);
  }, [routePlan, selectionContext, setSavedFeature, setSavedRoutePointId]);

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
      const resolved = resolveNavigationFeature(restoreRouteCoordinate(feature), navigationData);
      setSavedFeature(resolved);
      setSelectionContext({ feature: resolved, context, ...(routePointId === undefined ? {} : { routePointId }) });
    }
  }, [context, navigationData, setIdentificationOpen, setSavedRoutePointId, setActiveSidePanel, setSavedFeature]);
  useEffect(() => {
    if (!plates.mapImage || plates.mapImageRestored) return;
    setActiveSidePanel(null);
    setNearbyFeatures(undefined);
    setIdentificationOpen(false);
    setSavedRoutePointId(null);
    setSavedFeature(null);
    setSelectionContext(undefined);
  }, [plates.mapImage, plates.mapImageRestored]);

  const selected = selectionContext?.feature;
  const feature = useMemo(() => selected && weatherEnabled ? featureWithMetar(selected, weather) : selected,
    [selected, weather.metars, weatherEnabled]);
  // GPS coordinates have no published edition. Follow the current regional
  // context so a restored point adopts refreshed navigation references too.
  const readContext = selected?.properties.kind === 'coordinate' ? context : selectionContext?.context;
  const catalog = readContext && feature ? catalogForFeature(readContext, feature) : undefined;
  const identification = useNavaidIdentification(navigationEnabled && identificationOpen ? selected : undefined, catalog);
  const identificationMap = useMemo(() => identificationOpen && selected && identification.stations?.length
    ? { point: selected, stations: identification.stations } : undefined, [identificationOpen, selected, identification.stations]);
  useEffect(() => {
    if (!catalog || !readContext) return;
    const releaseCatalog = retainActiveCatalog(catalog);
    const bundle = readContext.bundles.find(bundle => bundle.catalog === catalog);
    const releaseFiles = bundle ? retainActiveFiles(retainedResourceUrls(bundle.plan)) : undefined;
    return () => { releaseCatalog(); releaseFiles?.(); };
  }, [catalog, readContext]);
  const chooseNearby = useCallback((features: NearbyFeature[], point: { x: number; y: number }) => setNearbyFeatures({ features, point }), []);
  const closeNearby = useCallback(() => setNearbyFeatures(undefined), []);

  return { selected, feature, routePointId: selectionContext?.routePointId, catalog,
    savedSupplement: readContext && feature ? supplementForFeature(readContext, feature) : undefined,
    identification: identificationOpen ? identification : undefined, identificationMap, setIdentificationOpen,
    activeSidePanel, setActiveSidePanel, nearbyFeatures, chooseNearby, closeNearby, selectFeature, openPlate };
}
