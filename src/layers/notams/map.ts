import type { Map as MapLibreMap } from 'maplibre-gl';
import type { NotamRecord } from '@zlayer/contracts';
import { createObstructionSymbol } from '../../core/graphics/obstruction-symbol';
import type { MapLayerModule } from '../../core/map/layer';
import { LayerScope } from '../../core/layers/scope';
import { createSourceSubmission } from '../../core/map/source-submission';
import { notamChartFeatures, notamChartKey } from './chart';

export const NOTAM_CHART_SOURCE = 'notam-graphics';
export const NOTAM_OBSTACLE_LAYER = 'notam-obstacle-symbols';
export const NOTAM_OBSTACLE_COLOR = '#ff9f43';
export const NOTAM_AREA_FILL = 'notam-area-fill';
export const NOTAM_AREA_LINE = 'notam-area-line';
export const NOTAM_AREA_LABEL = 'notam-area-labels';
const AREA_PATTERN = 'notam-area-hatch';
const layers = [NOTAM_AREA_FILL, NOTAM_AREA_LINE, NOTAM_AREA_LABEL, NOTAM_OBSTACLE_LAYER];
type Input = { records: readonly NotamRecord[]; now: number };
const icons = (['low', 'tall', 'wind', 'unknown'] as const).flatMap(shape => [false, true].map(grouped => ({
  id: `notam-obstacle-${shape}-${grouped ? 'group' : 'single'}`, shape, grouped,
})));

function areaPattern(): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  context.scale(2, 2);
  context.fillStyle = context.strokeStyle = NOTAM_OBSTACLE_COLOR;
  context.globalAlpha = .24; context.fillRect(0, 0, 16, 16);
  context.globalAlpha = .7; context.lineWidth = 1.5;
  context.beginPath();
  // Extend beyond each edge so the 16 px diagonal repeat has no seams.
  for (const offset of [-16, 0, 16]) {
    context.moveTo(offset - 16, 32); context.lineTo(offset + 32, -16);
  }
  context.stroke();
  return context.getImageData(0, 0, 32, 32);
}

export function createNotamChartLayer(onShown: (keys: readonly string[]) => void): MapLayerModule<Input> {
  let map: MapLibreMap | undefined, submission: ReturnType<typeof createSourceSubmission> | undefined;
  let scope: LayerScope | undefined;
  let collection = notamChartFeatures([], 0), key = '', pending = false, dirty = false;
  let records: readonly NotamRecord[] = [];
  let retry: ReturnType<typeof setTimeout> | undefined, retried = false;
  const visibility = (visible: boolean) => {
    for (const id of layers) if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    if (!visible) onShown([]);
  };
  const show = () => {
    if (!map || layers.some(id => !map!.getLayer(id))) { onShown([]); return; }
    const ids = new Set(collection.features.map(feature => feature.properties.noticeId));
    onShown(records.filter(record => ids.has(record.id)).map(notamChartKey));
  };
  const render = () => {
    const active = submission;
    if (!active || pending) return;
    dirty = false; pending = true;
    const version = active.begin(), data = collection;
    void active.submit(version, data).then(accepted => {
      if (accepted && !dirty) { retried = false; visibility(data.features.length > 0); show(); }
    }).catch(error => active.reject(version, error)).finally(() => {
      if (submission !== active) return;
      pending = false;
      if (dirty) render();
    });
  };
  return {
    id: 'notam-graphics', slot: 'annotation', overlayLayerIds: [NOTAM_AREA_FILL, NOTAM_AREA_LINE],
    foregroundLayerIds: [NOTAM_AREA_LABEL, NOTAM_OBSTACLE_LAYER],
    mount(target) {
      map = target;
      scope = new LayerScope();
      map.addSource(NOTAM_CHART_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      scope.add(() => { if (target.getSource(NOTAM_CHART_SOURCE)) target.removeSource(NOTAM_CHART_SOURCE); });
      for (const icon of icons) {
        map.addImage(icon.id, createObstructionSymbol({ ...icon, color: NOTAM_OBSTACLE_COLOR }), { pixelRatio: 2 });
        scope.add(() => { if (target.hasImage(icon.id)) target.removeImage(icon.id); });
      }
      map.addImage(AREA_PATTERN, areaPattern(), { pixelRatio: 2 });
      scope.add(() => { if (target.hasImage(AREA_PATTERN)) target.removeImage(AREA_PATTERN); });
      map.addLayer({ id: NOTAM_AREA_FILL, source: NOTAM_CHART_SOURCE, type: 'fill', filter: ['==', ['get', 'kind'], 'area'],
        layout: { visibility: 'none' }, paint: { 'fill-pattern': AREA_PATTERN } });
      scope.add(() => { if (target.getLayer(NOTAM_AREA_FILL)) target.removeLayer(NOTAM_AREA_FILL); });
      map.addLayer({ id: NOTAM_AREA_LINE, source: NOTAM_CHART_SOURCE, type: 'line', filter: ['==', ['get', 'kind'], 'area'],
        layout: { visibility: 'none' }, paint: { 'line-color': NOTAM_OBSTACLE_COLOR, 'line-width': 2.5, 'line-dasharray': [4, 3], 'line-opacity': 1 } });
      scope.add(() => { if (target.getLayer(NOTAM_AREA_LINE)) target.removeLayer(NOTAM_AREA_LINE); });
      map.addLayer({ id: NOTAM_AREA_LABEL, source: NOTAM_CHART_SOURCE, type: 'symbol', filter: ['==', ['get', 'kind'], 'area-label'],
        layout: { visibility: 'none', 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12,
          'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': .6, 'text-justify': 'auto' },
        paint: { 'text-color': NOTAM_OBSTACLE_COLOR, 'text-halo-color': '#081220', 'text-halo-width': 1.6 } });
      scope.add(() => { if (target.getLayer(NOTAM_AREA_LABEL)) target.removeLayer(NOTAM_AREA_LABEL); });
      map.addLayer({ id: NOTAM_OBSTACLE_LAYER, source: NOTAM_CHART_SOURCE, type: 'symbol', filter: ['==', ['get', 'kind'], 'obstacle'], layout: {
        visibility: 'none', 'icon-image': ['get', 'icon'], 'icon-size': 1.05, 'icon-allow-overlap': true,
        // Anchor the symbol's position dot (wind hub) to the published coordinate.
        'icon-offset': ['case', ['==', ['get', 'shape'], 'wind'], ['literal', [0, 3]], ['literal', [0, -8.5]]],
        'icon-optional': false, 'text-optional': true, 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'],
        'text-size': 12, 'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 1.3,
        'text-justify': 'auto', 'symbol-sort-key': ['-', 0, ['get', 'elevationMslFt']],
      }, paint: { 'text-color': NOTAM_OBSTACLE_COLOR, 'text-halo-color': '#081220', 'text-halo-width': 1.6 } });
      scope.add(() => { if (target.getLayer(NOTAM_OBSTACLE_LAYER)) target.removeLayer(NOTAM_OBSTACLE_LAYER); });
      submission = createSourceSubmission(map, NOTAM_CHART_SOURCE, () => {
        visibility(false);
        if (!retried && collection.features.length) {
          retried = true;
          retry = setTimeout(() => { retry = undefined; dirty = true; render(); }, 100);
        }
      });
      render();
    },
    update(input) {
      records = input.records;
      const next = notamChartFeatures(input.records, input.now), nextKey = JSON.stringify(next);
      if (key === nextKey && !submission?.failed) {
        if (submission && !pending) show();
        return;
      }
      key = nextKey; collection = next; dirty = true; retried = false;
      clearTimeout(retry); retry = undefined;
      // Stow/replacement takes effect before the worker accepts an empty/new source.
      submission?.invalidate(); visibility(false); render();
    },
    unmount() {
      clearTimeout(retry); retry = undefined;
      submission?.destroy(); submission = undefined; pending = false; dirty = false;
      onShown([]);
      map = undefined; scope?.dispose(); scope = undefined;
    },
  };
}
