import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { AirwayDataResponse, GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { NAVIGATION_LAYERS, DEFAULT_VISIBILITY, type LayerVisibility } from './definitions';
import { installNavigationLayers, INTERACTIVE_LAYER_IDS, PRIORITY_FIX_LAYER_ID, PRIORITY_FIX_SOURCE_ID, syncNavigationData, syncVisibility } from './renderer';
import { NAVIGATION_ICON_IDS } from './symbols';
import { DEFAULT_FIX_DISPLAY, fixDisplayData, indexFixDisplay, priorityFixData, type FixDisplayIndex, type FixDisplaySettings } from './fix-display';
import { type MapLayerModule, removeLayerResources } from '../../core/map/layer';
import { withMapLabelKeys } from '../../core/map/label';

type NavigationInput = {
  data: NavigationData; visibility: LayerVisibility;
  fixDisplay?: FixDisplaySettings;
  airways?: AirwayDataResponse | undefined;
  priorityFixes?: readonly GeoPointFeature[];
};
export function createNavigationLayer(): MapLayerModule<NavigationInput> {
  let map: MapLibreMap | undefined;
  let input: NavigationInput = { data: {}, visibility: DEFAULT_VISIBILITY };
  let fixes: FixDisplayIndex | undefined;
  let displayed: NavigationData = {};
  const renderPriority = () => {
    (map?.getSource(PRIORITY_FIX_SOURCE_ID) as GeoJSONSource | undefined)
      ?.setData(withMapLabelKeys(priorityFixData(input.priorityFixes ?? [])));
  };
  return {
    id: 'navigation', slot: 'navigation', interactiveLayerIds: INTERACTIVE_LAYER_IDS,
    foregroundLayerIds: [PRIORITY_FIX_LAYER_ID],
    mount(target) {
      map = target;
      installNavigationLayers(map);
      syncNavigationData(map, displayed);
      syncVisibility(map, input.visibility);
      renderPriority();
    },
    update(next) {
      const rebuild = input.data.fixes !== next.data.fixes || input.airways !== next.airways;
      const redrawFixes = rebuild || input.fixDisplay !== next.fixDisplay || input.priorityFixes !== next.priorityFixes;
      const visibilityChanged = input.visibility !== next.visibility;
      const priorityChanged = input.priorityFixes !== next.priorityFixes;
      input = next;
      if (rebuild) fixes = next.data.fixes ? indexFixDisplay(next.data.fixes, next.airways) : undefined;
      const previousData = displayed;
      displayed = { ...next.data };
      if (fixes) displayed.fixes = redrawFixes
        ? fixDisplayData(fixes, next.fixDisplay ?? DEFAULT_FIX_DISPLAY, next.priorityFixes) : previousData.fixes!;
      if (map) syncNavigationData(map, displayed, previousData);
      if (map && visibilityChanged) syncVisibility(map, next.visibility);
      if (priorityChanged) renderPriority();
    },
    unmount() {
      if (!map) return;
      removeLayerResources(map, [...NAVIGATION_LAYERS.flatMap(layer => [...layer.layerIds]), PRIORITY_FIX_LAYER_ID],
        [...NAVIGATION_LAYERS.map(layer => `nav-${layer.id}`), PRIORITY_FIX_SOURCE_ID]);
      for (const id of NAVIGATION_ICON_IDS) if (map.hasImage(id)) map.removeImage(id);
      map = undefined;
    },
  };
}
