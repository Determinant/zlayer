import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { AirwayDataResponse, GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { featureKey } from '@zlayer/domain';
import { NAVIGATION_LAYERS, DEFAULT_VISIBILITY, type LayerVisibility } from './definitions';
import { installNavigationLayers, INTERACTIVE_LAYER_IDS, NAVIGATION_FOCUS_LAYER_IDS, PRIORITY_FIX_LAYER_ID, PRIORITY_FIX_SOURCE_ID, syncNavigationData, syncVisibility } from './renderer';
import { NAVIGATION_ICON_IDS } from './symbols';
import { DEFAULT_FIX_DISPLAY, fixDisplayData, indexFixDisplay, priorityFixData, type FixDisplayIndex, type FixDisplaySettings } from './fix-display';
import { type MapLayerModule, removeLayerResources } from '../../core/map/layer';
import { withMapLabelKeys } from '../../core/map/label';
import { focusedLayerId } from '../../core/map/focus';
import { createSourceSubmission } from '../../core/map/source-submission';

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
  type Source = { submission: ReturnType<typeof createSourceSubmission>; data?: FeatureCollection;
    timer?: ReturnType<typeof setTimeout> | undefined; retried: boolean; hidden: boolean };
  const sources = new Map<string, Source>();
  const visibility = (id: string, hidden: boolean) => {
    const definition = NAVIGATION_LAYERS.find(layer => `nav-${layer.id}` === id);
    const ids = definition?.layerIds ?? [PRIORITY_FIX_LAYER_ID];
    const visible = !hidden && !!sources.get(id)?.data?.features.length && (!definition || input.visibility[definition.id]);
    const value = visible ? 'visible' : 'none';
    for (const layer of ids.flatMap(id => [id, focusedLayerId(id)])) {
      if (map?.getLayer(layer) && map.getLayoutProperty(layer, 'visibility') !== value) map.setLayoutProperty(layer, 'visibility', value);
    }
  };
  const submit = (id: string, data: FeatureCollection, retry = false) => {
    const source = sources.get(id);
    if (!source) return;
    source.data = data;
    if (!retry) { source.retried = false; clearTimeout(source.timer); source.timer = undefined; }
    if (!data.features.length) { source.hidden = true; visibility(id, true); }
    const version = source.submission.begin();
    void source.submission.submit(version, data).then(accepted => {
      if (accepted) { source.hidden = false; visibility(id, false); }
    }).catch(error => source.submission.reject(version, error));
  };
  const retryFailed = () => {
    for (const [id, source] of sources) if (source.submission.failed && source.timer === undefined && source.data) submit(id, source.data, true);
  };
  const renderPriority = () => {
    submit(PRIORITY_FIX_SOURCE_ID, withMapLabelKeys(priority));
  };
  return {
    id: 'navigation', slot: 'navigation', interactiveLayerIds: INTERACTIVE_LAYER_IDS,
    overlayLayerIds: [...NAVIGATION_LAYERS.find(layer => layer.id === 'airports')!.layerIds,
      'vfr-waypoints-icons', 'navaids-icons', 'fixes-icons'],
    foregroundLayerIds: [PRIORITY_FIX_LAYER_ID],
    focusedLayerIds: NAVIGATION_FOCUS_LAYER_IDS,
    mount(target) {
      map = target;
      installNavigationLayers(map);
      for (const id of [...NAVIGATION_LAYERS.map(layer => `nav-${layer.id}`), PRIORITY_FIX_SOURCE_ID]) {
        const source: Source = { retried: false, hidden: false, submission: createSourceSubmission(map, id, () => {
          source.hidden = true; visibility(id, true);
          if (!source.retried && source.data) {
            source.retried = true;
            source.timer = setTimeout(() => { source.timer = undefined; if (source.data) submit(id, source.data, true); }, 100);
          }
        }) };
        sources.set(id, source);
      }
      map.on('moveend', retryFailed);
      syncNavigationData(map, displayed, undefined, submit);
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
      if (map) syncNavigationData(map, displayed, previousData, submit);
      if (map && visibilityChanged) {
        syncVisibility(map, next.visibility);
        for (const [id, source] of sources) visibility(id, source.hidden);
        retryFailed();
      }
      if (priorityChanged) renderPriority();
    },
    unmount() {
      for (const source of sources.values()) { clearTimeout(source.timer); source.submission.destroy(); }
      sources.clear();
      if (!map) return;
      map.off('moveend', retryFailed);
      removeLayerResources(map, [...NAVIGATION_LAYERS.flatMap(layer => [...layer.layerIds]), PRIORITY_FIX_LAYER_ID, ...NAVIGATION_FOCUS_LAYER_IDS],
        [...NAVIGATION_LAYERS.map(layer => `nav-${layer.id}`), PRIORITY_FIX_SOURCE_ID]);
      for (const id of NAVIGATION_ICON_IDS) if (map.hasImage(id)) map.removeImage(id);
      map = undefined;
    },
  };
}
