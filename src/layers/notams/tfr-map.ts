import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection, Polygon } from 'geojson';
import type { MapLayerModule } from '../../core/map/layer';
import { createSourceSubmission } from '../../core/map/source-submission';
import { LayerScope } from '../../core/layers/scope';
import { tfrNextChange, tfrTiming } from './tfr-time';
import type { TfrState } from './tfr-client';
import type { TfrAreaSelection } from './tfr-selection';
import type { TfrNotice } from '@zlayer/contracts';

export const TFR_SOURCE = 'notam-tfrs', TFR_FILL = 'notam-tfr-fill', TFR_LINE = 'notam-tfr-line';
export const TFR_HIGHLIGHT = 'notam-tfr-highlight';
const TFR_HIGHLIGHT_HALO = 'notam-tfr-highlight-halo';
const highlights = [TFR_HIGHLIGHT_HALO, TFR_HIGHLIGHT];
const layers = [TFR_FILL, TFR_LINE, ...highlights];
type Input = TfrState & { highlighted?: string | undefined };
const ACTIVE = '#ff4d55', UPCOMING = '#ffd54a';
type Collection = FeatureCollection<Polygon, { noticeId: string; areaId: string; status: string; color: string }>;
export function tfrFeatures(state: TfrState): Collection {
  const features: Collection['features'] = [];
  for (const n of state.snapshot?.notices ?? []) for (const a of n.areas) {
    const timing = tfrTiming(n,a,state.now);
    if (!timing || !a.geometry) continue;
    // Colors follow the retained schedule; detail age and refresh failures are
    // qualified separately in the details panel and source review.
    const status = timing.status;
    features.push({ type: 'Feature', id: `${n.id}:${a.id}`, geometry: a.geometry,
      properties: { noticeId: n.id, areaId: a.id, status, color: status === 'upcoming' ? UPCOMING : ACTIVE } });
  }
  return { type: 'FeatureCollection', features };
}

function sameGeometry(a: Polygon, b: Polygon): boolean {
  return a === b || a.coordinates.length === b.coordinates.length && a.coordinates.every((ring, i) =>
    ring.length === b.coordinates[i]!.length && ring.every((point, j) =>
      point[0] === b.coordinates[i]![j]![0] && point[1] === b.coordinates[i]![j]![1]));
}

export function createTfrMapLayer(onShown: (notices: readonly TfrNotice[]) => void = () => {}): MapLayerModule<Input> & { inspectAt(point: { x: number; y: number }): TfrAreaSelection[] } {
  let map: MapLibreMap | undefined, scope: LayerScope | undefined, submission: ReturnType<typeof createSourceSubmission> | undefined;
  let collection = tfrFeatures({ now: 0, loading: false }), pending = false, dirty = false;
  let snapshot: TfrState['snapshot'], previousTime = -Infinity, nextChange = -Infinity;
  const colors = new Map<string, string>();
  let ready = false;
  let highlighted: string | undefined, highlightId: string | undefined;
  const emphasize = () => {
    if (!map || highlights.some(id => !map!.getLayer(id))) return;
    const id = ready ? highlighted ?? '' : '';
    if (highlightId === id) return;
    highlightId = id;
    for (const layer of highlights) map.setFilter(layer, ['==', ['get', 'noticeId'], id]);
  };
  let retry: ReturnType<typeof setTimeout> | undefined, retried = false;
  const reportShown = () => {
    const ids = new Set(collection.features.map(f => String(f.id)));
    onShown(ready ? (snapshot?.notices ?? []).filter(n => n.areas.length > 0 &&
      !snapshot?.issues?.some(issue => issue.id === n.id) && n.areas.every(a => ids.has(`${n.id}:${a.id}`))) : []);
  };
  const visible = (show: boolean) => {
    if (ready !== show) {
      ready = show;
      for (const id of layers) if (map?.getLayer(id)) map.setLayoutProperty(id,'visibility',show ? 'visible' : 'none');
    }
    emphasize();
    reportShown();
  };
  function style() {
    if (!map) return;
    const retained = new Set<string>();
    for (const feature of collection.features) {
      const id = String(feature.id), color = feature.properties.color;
      retained.add(id);
      if (colors.get(id) === color) continue;
      map.setFeatureState({ source: TFR_SOURCE, id }, { color });
      colors.set(id, color);
    }
    for (const id of colors.keys()) if (!retained.has(id)) {
      map.removeFeatureState({ source: TFR_SOURCE, id }); colors.delete(id);
    }
  }
  function render() {
    const active = submission;
    if (!active || pending) return;
    pending = true; dirty = false;
    const version = active.begin();
    // Only identity and geometry cross the worker boundary. Clock-driven colors
    // use feature state so a single aging detail cannot re-tile every TFR.
    const data: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: collection.features.map(feature => ({
      type: 'Feature', id: feature.id, geometry: feature.geometry,
      properties: { id: feature.id, noticeId: feature.properties.noticeId, areaId: feature.properties.areaId },
    })) };
    void active.submit(version,data).then(accepted => {
      if (accepted && !dirty) { style(); visible(data.features.length > 0); retried = false; }
    }).catch(error => active.reject(version,error)).finally(() => {
      if (submission !== active) return;
      pending = false; if (dirty) render();
    });
  }
  return {
    id: 'notam-tfrs', slot: 'annotation', areaLayerIds: layers, interactiveLayerIds: [TFR_FILL],
    inspectAt(point) {
      if (!map || !ready) return [];
      const hits = new Set(map.queryRenderedFeatures([point.x, point.y], { layers: [TFR_FILL] })
        .map(feature => `${feature.properties.noticeId}:${feature.properties.areaId}`));
      return collection.features.filter(feature => hits.has(String(feature.id)))
        .map(({ properties: { noticeId, areaId } }) => ({ noticeId, areaId }));
    },
    mount(target) {
      map = target; scope = new LayerScope();
      // Promote the string identity explicitly: vector-tile feature IDs are numeric.
      map.addSource(TFR_SOURCE,{ type: 'geojson', promoteId: 'id', data: { type: 'FeatureCollection', features: [] } });
      scope.add(() => { if (target.getSource(TFR_SOURCE)) target.removeSource(TFR_SOURCE); });
      map.addLayer({ id: TFR_FILL, type: 'fill', source: TFR_SOURCE, layout: { visibility: 'none' },
        paint: { 'fill-color': ['coalesce', ['feature-state','color'], ACTIVE], 'fill-opacity': .22 } });
      scope.add(() => { if (target.getLayer(TFR_FILL)) target.removeLayer(TFR_FILL); });
      map.addLayer({ id: TFR_LINE, type: 'line', source: TFR_SOURCE, layout: { visibility: 'none' },
        paint: { 'line-color': ['coalesce', ['feature-state','color'], ACTIVE], 'line-width': 2.5 } });
      scope.add(() => { if (target.getLayer(TFR_LINE)) target.removeLayer(TFR_LINE); });
      for (const [id, color, width] of [[TFR_HIGHLIGHT_HALO, '#081220', 7], [TFR_HIGHLIGHT, '#fff3cc', 3]] as const) {
        map.addLayer({ id, type: 'line', source: TFR_SOURCE, filter: ['==', ['get', 'noticeId'], ''],
          layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': color, 'line-width': width } });
        scope.add(() => { if (target.getLayer(id)) target.removeLayer(id); });
      }
      submission = createSourceSubmission(map,TFR_SOURCE,() => {
        visible(false);
        if (!retried && collection.features.length) { retried = true; retry = setTimeout(() => { dirty = true; render(); },100); }
      });
      render();
    },
    update(next) {
      highlighted = next.highlighted;
      if (snapshot === next.snapshot && next.now >= previousTime && next.now < nextChange && !submission?.failed) { emphasize(); return; }
      snapshot = next.snapshot; previousTime = next.now; nextChange = tfrNextChange(snapshot, next.now);
      const data = tfrFeatures(next);
      const sameSource = data.features.length === collection.features.length && data.features.every((feature, i) =>
        feature.id === collection.features[i]!.id && sameGeometry(feature.geometry, collection.features[i]!.geometry));
      collection = data;
      if (sameSource && !submission?.failed) { if (!pending) { style(); emphasize(); reportShown(); } return; }
      dirty = true; retried = false;
      clearTimeout(retry); submission?.invalidate(); visible(false); render();
    },
    unmount() {
      clearTimeout(retry); submission?.destroy(); submission = undefined; pending = false; dirty = false;
      ready = false; highlightId = undefined; reportShown(); colors.clear(); map = undefined; scope?.dispose(); scope = undefined;
    },
  };
}
