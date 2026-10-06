import type { Map as MapLibreMap } from 'maplibre-gl';
import type { GeoPointFeature } from '@zlayer/contracts';
import { formatWaypointLabel } from '../../core/format/coordinates';
import { removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { createSourceSubmission } from '../../core/map/source-submission';
import { mapLabelKey, selectionLabelOpacity, selectionMatch } from '../../core/map/label';
import { addFocusableLayer, focusedLayerId } from '../../core/map/focus';

const SOURCE = 'waypoint-inspection';
const FOCUSED_POINT = focusedLayerId('waypoint-inspection-point');
const LAYERS = ['waypoint-inspection-point', 'waypoint-inspection-label', FOCUSED_POINT];

/** One selected coordinate, with no route membership or editing handles. */
export function createWaypointInspectionLayer(): MapLayerModule<GeoPointFeature | undefined> {
  let map: MapLibreMap | undefined;
  let feature: GeoPointFeature | undefined;
  let submission: ReturnType<typeof createSourceSubmission> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined, retried = false;
  const visibility = (show: boolean) => {
    const value = show ? 'visible' : 'none';
    for (const id of LAYERS) if (map?.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== value) {
      map.setLayoutProperty(id, 'visibility', value);
    }
  };
  const render = () => {
    const active = submission, selected = feature;
    if (!active) return;
    if (!selected) visibility(false);
    const version = active.begin();
    void active.submit(version, { type: 'FeatureCollection', features: selected ? [{ ...selected,
      properties: { ...selected.properties,
        mapLabelKey: mapLabelKey(selected),
        inspectionLabel: formatWaypointLabel(selected.properties.ident ?? '').replaceAll('′', "'") },
    }] : [] }).then(accepted => {
      if (!accepted || !map) return;
      visibility(!!selected);
    }).catch(error => active.reject(version, error));
  };
  const retry = () => { if (submission?.failed && retryTimer === undefined) render(); };
  return {
    id: SOURCE, slot: 'navigation', overlayLayerIds: LAYERS, interactiveLayerIds: LAYERS, foregroundLayerIds: [LAYERS[1]!],
    focusedLayerIds: [FOCUSED_POINT],
    mount(target) {
      map = target;
      retried = false;
      map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      addFocusableLayer(map, { id: LAYERS[0]!, type: 'circle', source: SOURCE,
        paint: { 'circle-radius': 6, 'circle-color': '#e9f7ff', 'circle-stroke-color': '#33c6ff', 'circle-stroke-width': 2 } });
      map.addLayer({ id: LAYERS[1]!, type: 'symbol', source: SOURCE,
        filter: ['!', selectionMatch()],
        layout: { 'text-field': ['get', 'inspectionLabel'], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-anchor': 'left', 'text-offset': [1, 0],
          'text-allow-overlap': true },
        paint: { 'text-color': '#f4f8fc', 'text-halo-color': '#14222f', 'text-halo-width': 2,
          'text-opacity': selectionLabelOpacity(), 'text-opacity-transition': { duration: 0 } } });
      submission = createSourceSubmission(map, SOURCE, () => {
        visibility(false);
        if (!retried) {
          retried = true;
          retryTimer = setTimeout(() => { retryTimer = undefined; render(); }, 100);
        }
      });
      map.on('moveend', retry);
      render();
    },
    update(next) {
      if (feature === next) { retry(); return; }
      feature = next;
      retried = false; clearTimeout(retryTimer); retryTimer = undefined;
      render();
    },
    unmount() {
      clearTimeout(retryTimer); retryTimer = undefined;
      submission?.destroy(); submission = undefined;
      if (map) { map.off('moveend', retry); removeLayerResources(map, LAYERS, [SOURCE]); }
      map = undefined;
    },
  };
}
