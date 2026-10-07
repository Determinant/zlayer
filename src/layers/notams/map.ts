import type { ExpressionSpecification, Map as MapLibreMap } from 'maplibre-gl';
import type { NotamRecord } from '@zlayer/contracts';
import { createObstructionSymbol } from '../../core/graphics/obstruction-symbol';
import type { MapLayerModule } from '../../core/map/layer';
import { LayerScope } from '../../core/layers/scope';
import { createSourceSubmission } from '../../core/map/source-submission';
import { notamChartFeatures, notamChartKey, createNotamChartSelector } from './chart';
import type { NotamAreaReferences } from './area-references';

export const NOTAM_CHART_SOURCE = 'notam-graphics';
export const NOTAM_OBSTACLE_LAYER = 'notam-obstacle-symbols';
export const NOTAM_OBSTACLE_COLOR = '#ff9f43';
export const NOTAM_AREA_FILL = 'notam-area-fill';
export const NOTAM_AREA_LINE = 'notam-area-line';
export const NOTAM_ACTIVITY_POINT = 'notam-activity-points';
export const NOTAM_AREA_LABEL = 'notam-area-labels';
export const NOTAM_HIGHLIGHT_AREA = 'notam-highlight-area';
export const NOTAM_HIGHLIGHT_POINT = 'notam-highlight-point';
export const NOTAM_HIGHLIGHT_LABEL = 'notam-highlight-label';
export const NOTAM_HIGHLIGHT_RADIAL = 'notam-highlight-radial';
const HIGHLIGHT_AREA_HALO = 'notam-highlight-area-halo', HIGHLIGHT_POINT_HALO = 'notam-highlight-point-halo';
const HIGHLIGHT_COLOR = '#fff3cc';
const AREA_PATTERN = 'notam-area-hatch';
const RADIAL_ARROW = 'notam-radial-arrow';
const highlights = [HIGHLIGHT_AREA_HALO, NOTAM_HIGHLIGHT_AREA, HIGHLIGHT_POINT_HALO, NOTAM_HIGHLIGHT_POINT, NOTAM_HIGHLIGHT_RADIAL, NOTAM_HIGHLIGHT_LABEL];
const layers = [NOTAM_AREA_FILL, NOTAM_AREA_LINE, NOTAM_AREA_LABEL, NOTAM_ACTIVITY_POINT, NOTAM_OBSTACLE_LAYER, ...highlights];
type Input = { records: readonly NotamRecord[]; now: number; highlighted?: string | undefined; references?: NotamAreaReferences | undefined };
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

/** A fixed screen-size direction cue, with no geographic endpoint or range. */
function radialArrow(): ImageData {
  const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 208;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  context.scale(2, 2); context.lineJoin = 'round';
  for (const [color, width] of [['#081220', 7], [HIGHLIGHT_COLOR, 3]] as const) {
    context.strokeStyle = color; context.lineWidth = width;
    context.beginPath(); context.moveTo(12, 104); context.lineTo(12, 8);
    context.moveTo(4, 20); context.lineTo(12, 8); context.lineTo(20, 20); context.stroke();
  }
  return context.getImageData(0, 0, 48, 208);
}

export function createNotamChartLayer(onShown: (keys: readonly string[]) => void): MapLayerModule<Input> {
  let map: MapLibreMap | undefined, submission: ReturnType<typeof createSourceSubmission> | undefined;
  let scope: LayerScope | undefined;
  let collection = notamChartFeatures([], 0), key = '', pending = false, dirty = false;
  const selectFeatures = createNotamChartSelector();
  let records: readonly NotamRecord[] = [];
  let references: NotamAreaReferences | undefined;
  let now = NaN, highlighted: string | undefined, highlightId: string | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined, retried = false;
  const emphasize = () => {
    if (!map || highlights.some(id => !map!.getLayer(id))) return;
    const noticeId = highlighted ? records.find(record => notamChartKey(record) === highlighted)?.id ?? '' : '';
    if (noticeId === highlightId) return;
    highlightId = noticeId;
    for (const id of highlights) {
      const kind: ExpressionSpecification = id === NOTAM_HIGHLIGHT_LABEL ? ['in', ['get', 'kind'], ['literal', ['obstacle', 'area-label', 'activity', 'radial-label']]]
        : id === NOTAM_HIGHLIGHT_RADIAL ? ['==', ['get', 'kind'], 'radial']
        : id === HIGHLIGHT_AREA_HALO || id === NOTAM_HIGHLIGHT_AREA ? ['==', ['get', 'kind'], 'area']
          : ['in', ['get', 'kind'], ['literal', ['obstacle', 'activity', 'radial-label']]];
      map.setFilter(id, ['all', kind, ['in', noticeId, ['get', 'noticeIds']]]);
    }
    // The emphasized label replaces its ordinary label instead of doubling it.
    for (const id of [NOTAM_AREA_LABEL, NOTAM_OBSTACLE_LAYER]) {
      map.setPaintProperty(id, 'text-opacity', ['case', ['in', noticeId, ['get', 'noticeIds']], 0, 1]);
    }
  };
  const visibility = (visible: boolean) => {
    for (const id of layers) if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    if (!visible) onShown([]);
  };
  const show = () => {
    if (!map || layers.some(id => !map!.getLayer(id))) { onShown([]); return; }
    const ids = new Set(collection.features.flatMap(feature => feature.properties.noticeIds));
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
    id: 'notam-graphics', slot: 'annotation', areaLayerIds: [NOTAM_AREA_FILL, NOTAM_AREA_LINE, HIGHLIGHT_AREA_HALO, NOTAM_HIGHLIGHT_AREA],
    foregroundLayerIds: [NOTAM_ACTIVITY_POINT, NOTAM_AREA_LABEL, NOTAM_OBSTACLE_LAYER],
    focusedLayerIds: [HIGHLIGHT_POINT_HALO, NOTAM_HIGHLIGHT_POINT, NOTAM_HIGHLIGHT_RADIAL, NOTAM_HIGHLIGHT_LABEL],
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
      map.addImage(RADIAL_ARROW, radialArrow(), { pixelRatio: 2 });
      scope.add(() => { if (target.hasImage(RADIAL_ARROW)) target.removeImage(RADIAL_ARROW); });
      map.addLayer({ id: NOTAM_AREA_FILL, source: NOTAM_CHART_SOURCE, type: 'fill', filter: ['==', ['get', 'kind'], 'area'],
        layout: { visibility: 'none' }, paint: { 'fill-pattern': AREA_PATTERN } });
      scope.add(() => { if (target.getLayer(NOTAM_AREA_FILL)) target.removeLayer(NOTAM_AREA_FILL); });
      map.addLayer({ id: NOTAM_AREA_LINE, source: NOTAM_CHART_SOURCE, type: 'line', filter: ['==', ['get', 'kind'], 'area'],
        layout: { visibility: 'none' }, paint: { 'line-color': NOTAM_OBSTACLE_COLOR, 'line-width': 2.5, 'line-dasharray': [4, 3], 'line-opacity': 1 } });
      scope.add(() => { if (target.getLayer(NOTAM_AREA_LINE)) target.removeLayer(NOTAM_AREA_LINE); });
      map.addLayer({ id: NOTAM_AREA_LABEL, source: NOTAM_CHART_SOURCE, type: 'symbol', filter: ['in', ['get', 'kind'], ['literal', ['area-label', 'activity']]],
        layout: { visibility: 'none', 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12,
          'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': .6, 'text-justify': 'auto' },
        paint: { 'text-color': NOTAM_OBSTACLE_COLOR, 'text-halo-color': '#081220', 'text-halo-width': 1.6 } });
      scope.add(() => { if (target.getLayer(NOTAM_AREA_LABEL)) target.removeLayer(NOTAM_AREA_LABEL); });
      map.addLayer({ id: NOTAM_ACTIVITY_POINT, source: NOTAM_CHART_SOURCE, type: 'circle', filter: ['==', ['get', 'kind'], 'activity'],
        layout: { visibility: 'none' }, paint: { 'circle-radius': 4, 'circle-color': NOTAM_OBSTACLE_COLOR,
          'circle-stroke-color': '#081220', 'circle-stroke-width': 1.5 } });
      scope.add(() => { if (target.getLayer(NOTAM_ACTIVITY_POINT)) target.removeLayer(NOTAM_ACTIVITY_POINT); });
      map.addLayer({ id: NOTAM_OBSTACLE_LAYER, source: NOTAM_CHART_SOURCE, type: 'symbol', filter: ['==', ['get', 'kind'], 'obstacle'], layout: {
        visibility: 'none', 'icon-image': ['get', 'icon'], 'icon-size': 1.05, 'icon-allow-overlap': true,
        // Anchor the symbol's position dot (wind hub) to the published coordinate.
        'icon-offset': ['case', ['==', ['get', 'shape'], 'wind'], ['literal', [0, 3]], ['literal', [0, -8.5]]],
        'icon-optional': false, 'text-optional': true, 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'],
        'text-size': 12, 'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 1.3,
        'text-justify': 'auto', 'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'elevationMslFt'], 0]],
      }, paint: { 'text-color': NOTAM_OBSTACLE_COLOR, 'text-halo-color': '#081220', 'text-halo-width': 1.6 } });
      scope.add(() => { if (target.getLayer(NOTAM_OBSTACLE_LAYER)) target.removeLayer(NOTAM_OBSTACLE_LAYER); });
      for (const [id, color, width] of [[HIGHLIGHT_AREA_HALO, '#081220', 7], [NOTAM_HIGHLIGHT_AREA, HIGHLIGHT_COLOR, 3]] as const) {
        map.addLayer({ id, source: NOTAM_CHART_SOURCE, type: 'line', filter: ['==', ['get', 'noticeId'], ''],
          layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': color, 'line-width': width } });
        scope.add(() => { if (target.getLayer(id)) target.removeLayer(id); });
      }
      for (const [id, color, width] of [[HIGHLIGHT_POINT_HALO, '#081220', 7], [NOTAM_HIGHLIGHT_POINT, HIGHLIGHT_COLOR, 2.5]] as const) {
        map.addLayer({ id, source: NOTAM_CHART_SOURCE, type: 'circle', filter: ['==', ['get', 'noticeId'], ''],
          layout: { visibility: 'none' }, paint: { 'circle-radius': 19, 'circle-opacity': 0,
            'circle-stroke-color': color, 'circle-stroke-width': width } });
        scope.add(() => { if (target.getLayer(id)) target.removeLayer(id); });
      }
      map.addLayer({ id: NOTAM_HIGHLIGHT_RADIAL, source: NOTAM_CHART_SOURCE, type: 'symbol', filter: ['==', ['get', 'noticeId'], ''],
        layout: { visibility: 'none', 'icon-image': RADIAL_ARROW, 'icon-anchor': 'bottom', 'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
      scope.add(() => { if (target.getLayer(NOTAM_HIGHLIGHT_RADIAL)) target.removeLayer(NOTAM_HIGHLIGHT_RADIAL); });
      map.addLayer({ id: NOTAM_HIGHLIGHT_LABEL, source: NOTAM_CHART_SOURCE, type: 'symbol', filter: ['==', ['get', 'noticeId'], ''],
        layout: { visibility: 'none', 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 13,
          'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 1.7, 'text-justify': 'auto',
          'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': HIGHLIGHT_COLOR, 'text-halo-color': '#081220', 'text-halo-width': 2 } });
      scope.add(() => { if (target.getLayer(NOTAM_HIGHLIGHT_LABEL)) target.removeLayer(NOTAM_HIGHLIGHT_LABEL); });
      emphasize();
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
      highlighted = input.highlighted;
      // Pointer/focus changes update filters only; parsing and worker geometry stay untouched.
      if (records === input.records && now === input.now && references === input.references && !submission?.failed) { emphasize(); return; }
      records = input.records;
      references = input.references;
      now = input.now;
      emphasize();
      const next = selectFeatures(input.records, input.now, references);
      if (next === collection && !submission?.failed) {
        if (submission && !pending) show();
        return;
      }
      const nextKey = next === collection ? key : JSON.stringify(next);
      if (key === nextKey && !submission?.failed) {
        collection = next;
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
      highlightId = undefined;
      map = undefined; scope?.dispose(); scope = undefined;
    },
  };
}
