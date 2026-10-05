import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection, Polygon } from 'geojson';
import type { MapLayerModule } from '../../core/map/layer';
import { createSourceSubmission } from '../../core/map/source-submission';
import { LayerScope } from '../../core/layers/scope';
import { tfrTiming } from './tfr-time';
import type { TfrState } from './tfr-client';
import type { TfrAreaSelection } from './tfr-selection';

export const TFR_SOURCE = 'notam-tfrs', TFR_FILL = 'notam-tfr-fill', TFR_LINE = 'notam-tfr-line';
const layers = [TFR_FILL, TFR_LINE];
const ACTIVE = '#ff4d55', UPCOMING = '#ffd54a';
type Collection = FeatureCollection<Polygon, { noticeId: string; areaId: string; status: string; color: string }>;
export function tfrFeatures(state: TfrState): Collection {
  const features: Collection['features'] = [];
  for (const n of state.snapshot?.notices ?? []) for (const a of n.areas) {
    const timing = tfrTiming(n,a,state.now);
    if (!timing || !a.geometry) continue;
    features.push({ type: 'Feature', id: `${n.id}:${a.id}`, geometry: a.geometry,
      properties: { noticeId: n.id, areaId: a.id, status: timing.status, color: timing.status === 'upcoming' ? UPCOMING : ACTIVE } });
  }
  return { type: 'FeatureCollection', features };
}

export function createTfrMapLayer(): MapLayerModule<TfrState> & { inspectAt(point: { x: number; y: number }): TfrAreaSelection[] } {
  let map: MapLibreMap | undefined, scope: LayerScope | undefined, submission: ReturnType<typeof createSourceSubmission> | undefined;
  let state: TfrState = { now: 0, loading: false }, collection = tfrFeatures(state), key = '', pending = false, dirty = false;
  let ready = false;
  let retry: ReturnType<typeof setTimeout> | undefined, retried = false;
  const visible = (show: boolean) => { ready = show; for (const id of layers) if (map?.getLayer(id)) map.setLayoutProperty(id,'visibility',show ? 'visible' : 'none'); };
  function render() {
    const active = submission;
    if (!active || pending) return;
    pending = true; dirty = false;
    const version = active.begin(), data = collection;
    void active.submit(version,data).then(accepted => {
      if (accepted && !dirty) { visible(data.features.length > 0); retried = false; }
    }).catch(error => active.reject(version,error)).finally(() => {
      if (submission !== active) return;
      pending = false; if (dirty) render();
    });
  }
  return {
    id: 'notam-tfrs', slot: 'annotation', overlayLayerIds: layers, interactiveLayerIds: [TFR_FILL],
    inspectAt(point) {
      if (!map || !ready) return [];
      const hits = new Set(map.queryRenderedFeatures([point.x, point.y], { layers: [TFR_FILL] })
        .map(feature => `${feature.properties.noticeId}:${feature.properties.areaId}`));
      return collection.features.filter(feature => hits.has(String(feature.id)))
        .map(({ properties: { noticeId, areaId } }) => ({ noticeId, areaId }));
    },
    mount(target) {
      map = target; scope = new LayerScope();
      map.addSource(TFR_SOURCE,{ type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      scope.add(() => { if (target.getSource(TFR_SOURCE)) target.removeSource(TFR_SOURCE); });
      map.addLayer({ id: TFR_FILL, type: 'fill', source: TFR_SOURCE, layout: { visibility: 'none' },
        paint: { 'fill-color': ['get','color'], 'fill-opacity': .22 } });
      scope.add(() => { if (target.getLayer(TFR_FILL)) target.removeLayer(TFR_FILL); });
      map.addLayer({ id: TFR_LINE, type: 'line', source: TFR_SOURCE, layout: { visibility: 'none' },
        paint: { 'line-color': ['get','color'], 'line-width': 2.5 } });
      scope.add(() => { if (target.getLayer(TFR_LINE)) target.removeLayer(TFR_LINE); });
      submission = createSourceSubmission(map,TFR_SOURCE,() => {
        visible(false);
        if (!retried && collection.features.length) { retried = true; retry = setTimeout(() => { dirty = true; render(); },100); }
      });
      render();
    },
    update(next) {
      state = next;
      const data = tfrFeatures(state), nextKey = JSON.stringify(data);
      if (key === nextKey && !submission?.failed) return;
      key = nextKey; collection = data; dirty = true; retried = false;
      clearTimeout(retry); submission?.invalidate(); visible(false); render();
    },
    unmount() {
      clearTimeout(retry); submission?.destroy(); submission = undefined; pending = false; dirty = false;
      ready = false; map = undefined; scope?.dispose(); scope = undefined;
    },
  };
}
