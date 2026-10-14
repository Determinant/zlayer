import type { Map } from 'maplibre-gl';
import { createSourceSubmission } from '../../../core/map/source-submission';
import { WEATHER_LAYER_ANCHOR } from '../../../core/map/layer';
import type { WeatherController } from '../controller';
import { selectedPireps } from './selection';

const SOURCE = 'weather-awc-pireps';
export const PIREP_LAYER = 'weather-awc-pirep-circles';
const HIGHLIGHT_HALO = 'weather-awc-pirep-highlight-halo', HIGHLIGHT = 'weather-awc-pirep-highlight';
export const PIREP_HIGHLIGHT_LAYERS = [HIGHLIGHT_HALO, HIGHLIGHT];
const LAYERS = [PIREP_LAYER, ...PIREP_HIGHLIGHT_LAYERS];
export const PIREP_COLOR = '#00b8e8', PIREP_URGENT_COLOR = '#b77cff';
const RADIUS = 9, URGENT_RADIUS = 11, STROKE = 2, PICK_PADDING = 6;

/** Point observations use fixed screen-size circles, with no geographic radius. */
export function mountPirepMap(map: Map, controller: WeatherController) {
  let previous = '', attempted: unknown, retry = -1, destroyed = false;
  let reports = selectedPireps(controller.getSnapshot());
  let accepted = new Set<string>();
  let highlighted = '';
  const resources = () => {
    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: PIREP_LAYER, type: 'circle', source: SOURCE,
      layout: { visibility: 'none', 'circle-sort-key': ['case', ['get', 'urgent'], 1, 0] },
      paint: { 'circle-radius': ['case', ['get', 'urgent'], URGENT_RADIUS, RADIUS], 'circle-opacity': .12, 'circle-pitch-scale': 'viewport',
        'circle-color': ['case', ['get', 'urgent'], PIREP_URGENT_COLOR, PIREP_COLOR],
        'circle-stroke-color': ['case', ['get', 'urgent'], PIREP_URGENT_COLOR, PIREP_COLOR], 'circle-stroke-width': STROKE } }, WEATHER_LAYER_ANCHOR);
    // Match NOTAM's bright, dark-backed emphasis without covering the chart.
    for (const [id, color, width] of [[HIGHLIGHT_HALO, '#081220', 7], [HIGHLIGHT, '#fff3cc', 2.5]] as const) {
      map.addLayer({ id, type: 'circle', source: SOURCE, filter: ['==', ['get', 'id'], ''],
        layout: { visibility: 'none' }, paint: { 'circle-radius': ['case', ['get', 'urgent'], 16, 14],
          'circle-opacity': 0, 'circle-pitch-scale': 'viewport', 'circle-stroke-color': color, 'circle-stroke-width': width } }, WEATHER_LAYER_ANCHOR);
    }
    highlighted = '';
  };
  const remove = () => {
    for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  };
  const visible = (show: boolean) => {
    for (const id of LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
  };
  const highlight = () => {
    const state = controller.getSnapshot(), selected = state.pirepHighlight ?? state.pirepSelection?.id ?? '';
    const id = accepted.has(selected) ? selected : '';
    if (id === highlighted) return;
    highlighted = id;
    for (const layer of PIREP_HIGHLIGHT_LAYERS) map.setFilter(layer, ['==', ['get', 'id'], id]);
  };
  const view = () => {
    if (destroyed) return;
    const canvas = map.getCanvas(), center = map.getCenter().lng;
    const ids = reports.filter(r => {
      // Project the visible world copy; bounds alone overcount rotated views.
      const lng = r.longitude + 360 * Math.round((center - r.longitude) / 360);
      const point = map.project([lng, r.latitude]);
      // Include every circle that can intersect the pick box at a viewport edge.
      const dx = Math.max(-PICK_PADDING - point.x, 0, point.x - canvas.clientWidth - PICK_PADDING);
      const dy = Math.max(-PICK_PADDING - point.y, 0, point.y - canvas.clientHeight - PICK_PADDING);
      return Math.hypot(dx, dy) <= (r.urgent ? URGENT_RADIUS : RADIUS) + STROKE;
    }).map(r => r.id);
    controller.setPirepView(ids);
  };
  resources();
  const submission = createSourceSubmission(map, SOURCE, error => {
    accepted.clear();
    visible(false); highlight();
    controller.setPirepDisplay({ loading: false, error: `PIREP rendering failed: ${String(error)}` });
  });
  const pick = (point: { x: number; y: number }) => !destroyed && accepted.size && map.getLayer(PIREP_LAYER)
    ? [...new Set(map.queryRenderedFeatures([[point.x - PICK_PADDING, point.y - PICK_PADDING], [point.x + PICK_PADDING, point.y + PICK_PADDING]], { layers: [PIREP_LAYER] })
      .map(f => String(f.properties.id)).filter(id => accepted.has(id)))] : [];
  controller.setPirepPicker(pick);
  map.on('moveend', view); map.on('resize', view);
  return {
    highlight,
    update() {
      const state = controller.getSnapshot();
      reports = selectedPireps(state);
      const identity = reports.map(r => `${r.id}:${r.longitude}:${r.latitude}`).join('|');
      const resolved = state.pireps.resolved ?? state.pireps.snapshot;
      const recover = submission.failed && (retry !== state.pirepRetry || attempted !== resolved);
      highlight();
      if (identity === previous && !recover) return;
      previous = identity; retry = state.pirepRetry; attempted = resolved;
      const reset = submission.failed;
      submission.invalidate(); accepted.clear();
      visible(false); highlight(); view();
      if (!reports.length) { controller.setPirepDisplay({ loading: false }); return; }
      const version = submission.begin(), chosen = reports;
      controller.setPirepDisplay({ loading: true });
      void (async () => {
        if (reset) {
          const layers = map.getStyle().layers;
          const positions = LAYERS.map(id => ({ id, before: layers[layers.findIndex(l => l.id === id) + 1]?.id }));
          remove(); resources();
          for (const { id, before } of positions.reverse()) map.moveLayer(id, before);
        }
        if (!await submission.submit(version, { type: 'FeatureCollection', features: chosen.map(r => ({ type: 'Feature', id: r.id,
          geometry: { type: 'Point', coordinates: [r.longitude, r.latitude] }, properties: { id: r.id, urgent: r.urgent } })) })) return;
        accepted = new Set(chosen.map(r => r.id));
        highlight(); visible(true);
        controller.setPirepDisplay({ loading: false });
      })().catch(error => submission.reject(version, error));
    },
    destroy() {
      destroyed = true; controller.setPirepPicker(undefined); submission.destroy();
      map.off('moveend', view); map.off('resize', view); remove();
      controller.setPirepView([]); controller.setPirepDisplay({ loading: false });
    },
  };
}
