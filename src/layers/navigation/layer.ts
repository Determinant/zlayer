import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { AirwayDataResponse, GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { featureKey } from '@zlayer/domain';
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
  let priority = priorityFixData([]);
  let priorityKeys = new Set<string>();
  const renderPriority = () => {
    (map?.getSource(PRIORITY_FIX_SOURCE_ID) as GeoJSONSource | undefined)
      ?.setData(withMapLabelKeys(priority));
  };
  return {
    id: 'navigation', slot: 'navigation', interactiveLayerIds: INTERACTIVE_LAYER_IDS,
    overlayLayerIds: [...NAVIGATION_LAYERS.find(layer => layer.id === 'airports')!.layerIds,
      'vfr-waypoints-icons', 'navaids-icons', 'fixes-icons'],
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
      const previousSettings = input.fixDisplay ?? DEFAULT_FIX_DISPLAY;
      const settings = next.fixDisplay ?? DEFAULT_FIX_DISPLAY;
      let priorityChanged = false, priorityKeysChanged = false;
      if (input.priorityFixes !== next.priorityFixes) {
        const nextPriority = priorityFixData(next.priorityFixes ?? []);
        priorityChanged = nextPriority.features.length !== priority.features.length ||
          nextPriority.features.some((feature, index) => feature !== priority.features[index]);
        priority = nextPriority;
        const nextKeys = new Set((next.priorityFixes ?? []).map(featureKey));
        priorityKeysChanged = nextKeys.size !== priorityKeys.size || [...nextKeys].some(key => !priorityKeys.has(key));
        priorityKeys = nextKeys;
      }
      const redrawFixes = rebuild || previousSettings.detail !== settings.detail ||
        (settings.detail !== 'all' && previousSettings.airspace !== settings.airspace) || priorityKeysChanged;
      const visibilityChanged = input.visibility !== next.visibility;
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
