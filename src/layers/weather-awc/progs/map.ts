import type { Map, ExpressionSpecification } from 'maplibre-gl';
import { createSourceSubmission } from '../source-submission';
import type { SurfaceBoundary, SurfaceFrame, SurfacePhase } from '@zlayer/contracts';
import type { WeatherController } from '../controller';
import { isSurfacePressureLabel, SURFACE_COLORS } from './palette';

const SOURCE = 'weather-awc-progs';
const layer = (name: string) => `weather-awc-progs-${name}`;
export const SURFACE_LAYERS = ['isobars', 'halo', 'troughs', 'fronts', 'labels', 'pressure-labels', 'centers', 'tropical'].map(layer);
const ISOBAR_LAYERS = ['isobars', 'pressure-labels'].map(layer);
const imageId = (kind: string, phase = 'normal') => `weather-awc-front-${kind}-${phase}`;
const fronts = ['COLD', 'WARM', 'STNRY', 'OCFNT', 'DRYLINE', 'SQUALL'] as const;

/** A repeating, directed line texture avoids symbol collision/auto-flipping.
 * Symbols are on the left of the ordered WPC boundary; stationary warm symbols
 * occupy the opposite side. Render at 2× for high-density screens. */
function frontImage(kind: SurfaceBoundary, phase: SurfacePhase): ImageData {
  const canvas = document.createElement('canvas'); canvas.width = phase === 'weakening' ? 256 : 128; canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  // MapLibre's line texture v axis runs toward the boundary's left side;
  // invert canvas y so the drawn upper symbols stay left of WPC's order.
  ctx.setTransform(2, 0, 0, -2, 0, canvas.height);
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  const width = canvas.width / 2;
  const dashed = phase !== 'normal' || kind === 'SQUALL';
  const line = (from: number, to: number, color: string) => {
    ctx.setLineDash(dashed ? [12, 6] : []);
    ctx.beginPath(); ctx.moveTo(from, 12); ctx.lineTo(to, 12); ctx.strokeStyle = color; ctx.stroke(); ctx.setLineDash([]);
  };
  const triangle = (x: number, color: string) => {
    ctx.beginPath(); ctx.moveTo(x - 5, 12); ctx.lineTo(x, 5); ctx.lineTo(x + 5, 12); ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
  };
  const semicircle = (x: number, color: string, below = false) => {
    ctx.beginPath(); ctx.arc(x, 12, 5, below ? 0 : Math.PI, below ? Math.PI : 2 * Math.PI); ctx.closePath();
    ctx.fillStyle = color;
    if (kind === 'DRYLINE') { ctx.strokeStyle = color; ctx.stroke(); } else ctx.fill();
  };
  if (kind === 'STNRY') {
    line(0, width / 2, SURFACE_COLORS.COLD); line(width / 2, width, SURFACE_COLORS.WARM);
    triangle(width / 4, SURFACE_COLORS.COLD); semicircle(width * 3 / 4, SURFACE_COLORS.WARM, true);
  } else if (kind === 'SQUALL') {
    line(0, width, SURFACE_COLORS.SQUALL);
    for (const x of [16, 48]) {
      ctx.beginPath(); ctx.arc(x, 12, 3, 0, Math.PI * 2); ctx.fillStyle = SURFACE_COLORS.SQUALL; ctx.fill();
    }
  } else {
    line(0, width, SURFACE_COLORS[kind]);
    if (kind === 'COLD' || kind === 'OCFNT') triangle(width / 4, SURFACE_COLORS[kind]);
    else semicircle(width / 4, SURFACE_COLORS[kind]);
    if (kind === 'COLD') triangle(width * 3 / 4, SURFACE_COLORS[kind]);
    else semicircle(width * 3 / 4, SURFACE_COLORS[kind]);
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function cycloneImage(hurricane: boolean): ImageData {
  const canvas = document.createElement('canvas'); canvas.width = 56; canvas.height = 56;
  const ctx = canvas.getContext('2d')!; ctx.scale(2, 2);
  ctx.translate(14, 14); ctx.lineCap = 'round';
  const path = () => {
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, 2 * Math.PI);
    ctx.moveTo(-5, 0); ctx.bezierCurveTo(-10, -5, -6, -10, -2, -11);
    ctx.moveTo(5, 0); ctx.bezierCurveTo(10, 5, 6, 10, 2, 11);
  };
  path(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.stroke();
  path(); ctx.strokeStyle = SURFACE_COLORS.HURRICANE; ctx.lineWidth = 2.5; ctx.stroke();
  if (hurricane) { ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fillStyle = SURFACE_COLORS.HURRICANE; ctx.fill(); }
  return ctx.getImageData(0, 0, 56, 56);
}

export function mountProgsMap(map: Map, controller: WeatherController, before: string) {
  let shown: SurfaceFrame | undefined, key = '', destroyed = false;
  let isobars = controller.getSnapshot().preferences.awcProgsIsobars;
  let retry = controller.getSnapshot().progsRetry;
  const images = new Set<string>();
  const clearResources = () => {
    for (const id of [...SURFACE_LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    for (const id of images) if (map.hasImage(id)) map.removeImage(id);
    images.clear();
  };
  const visibility = (visible: boolean) => {
    for (const id of SURFACE_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible && (!ISOBAR_LAYERS.includes(id) || isobars) ? 'visible' : 'none');
  };
  const submission = createSourceSubmission(map, SOURCE, error => {
    shown = undefined; visibility(false);
    controller.setProgsRenderError(error instanceof Error ? error.message : 'Surface rendering failed');
  });
  const update = () => {
    if (destroyed) return;
    const state = controller.getSnapshot(), selection = controller.surfaceSelection();
    if (isobars !== state.preferences.awcProgsIsobars) {
      isobars = state.preferences.awcProgsIsobars;
      for (const id of ISOBAR_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', shown && isobars ? 'visible' : 'none');
    }
    const frame = state.preferences.awcEnabled && state.preferences.awcProgs ? selection.frame : undefined;
    const identity = frame ? `${frame.artifactHash ?? state.progs[selection.product].snapshot!.sourceHash}:${frame.validTime}` : '';
    const retryRender = !!state.progsRenderError && retry !== state.progsRetry;
    retry = state.progsRetry;
    if (key === identity && !retryRender) return;
    if (submission.failed) clearResources();
    key = identity;
    const version = submission.begin();
    // Never leave the old frame visible under the newly selected valid time.
    shown = undefined; visibility(false); controller.setProgsRenderError(undefined);
    if (!frame) { submission.invalidate(); return; }
    void (async () => {
      if (!map.getSource(SOURCE)) {
        map.addSource(SOURCE, { type: 'geojson', attribution: 'NOAA / Weather Prediction Center', tolerance: 0,
          data: { type: 'FeatureCollection', features: [] } });
        for (const kind of fronts) for (const phase of ['normal', 'forming', 'weakening'] as const) {
          const id = imageId(kind, phase); map.addImage(id, frontImage(kind, phase), { pixelRatio: 2 }); images.add(id);
        }
        for (const kind of ['HURRICANE', 'TROPICAL_STORM']) {
          const id = imageId(kind); map.addImage(id, cycloneImage(kind === 'HURRICANE'), { pixelRatio: 2 }); images.add(id);
        }
        const lines: ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
        map.addLayer({ id: layer('isobars'), type: 'line', source: SOURCE, filter: ['==', ['get', 'kind'], 'ISOBAR'],
          layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': SURFACE_COLORS.ISOBAR, 'line-width': 1.2 } }, before);
        map.addLayer({ id: layer('halo'), type: 'line', source: SOURCE, filter: ['all', lines, ['!=', ['get', 'kind'], 'ISOBAR']],
          layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-opacity': 0.9 } }, before);
        map.addLayer({ id: layer('troughs'), type: 'line', source: SOURCE, filter: ['==', ['get', 'kind'], 'TROF'],
          layout: { visibility: 'none', 'line-join': 'round' },
          paint: { 'line-color': SURFACE_COLORS.TROF, 'line-width': 2, 'line-dasharray': [5, 3] } }, before);
        map.addLayer({ id: layer('fronts'), type: 'line', source: SOURCE,
          filter: ['all', lines, ['in', ['get', 'kind'], ['literal', fronts]]], layout: { visibility: 'none', 'line-join': 'round' },
          paint: { 'line-width': 24, 'line-pattern': ['concat', 'weather-awc-front-', ['get', 'kind'], '-', ['get', 'phase']] } }, before);
        for (const pressure of [false, true]) map.addLayer({ id: layer(pressure ? 'pressure-labels' : 'labels'), type: 'symbol', source: SOURCE,
          filter: ['all', ['==', ['get', 'kind'], 'LABEL'], ['==', ['get', 'pressureLabel'], pressure]],
          layout: { visibility: 'none', 'text-field': ['get', 'text'], 'text-font': ['Noto Sans Regular'], 'text-size': 12,
            'text-allow-overlap': true, 'text-ignore-placement': true, 'text-padding': 0 },
          paint: { 'text-color': ['case', ['==', ['get', 'txtcol'], '6'], '#202020', SURFACE_COLORS.LABEL],
            'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } }, before);
        map.addLayer({ id: layer('centers'), type: 'symbol', source: SOURCE, filter: ['in', ['get', 'kind'], ['literal', ['HIGH', 'LOW']]],
          layout: { visibility: 'none', 'text-field': ['case', ['==', ['get', 'kind'], 'HIGH'], 'H', 'L'],
            'text-font': ['Noto Sans Bold'], 'text-size': 24, 'text-padding': 4,
            'text-allow-overlap': true, 'text-ignore-placement': true },
          paint: { 'text-color': ['case', ['==', ['get', 'kind'], 'HIGH'], SURFACE_COLORS.HIGH, SURFACE_COLORS.LOW],
            'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } }, before);
        map.addLayer({ id: layer('tropical'), type: 'symbol', source: SOURCE, filter: ['in', ['get', 'kind'], ['literal', ['HURRICANE', 'TROPICAL_STORM']]],
          layout: { visibility: 'none', 'icon-image': ['concat', 'weather-awc-front-', ['get', 'kind'], '-normal'],
            'icon-allow-overlap': true, 'icon-ignore-placement': true } }, before);
      }
      const accepted = await submission.submit(version, { type: 'FeatureCollection', features: frame.features.map(feature => ({
        type: 'Feature', id: feature.id, geometry: feature.geometry, properties: { id: feature.id, kind: feature.kind,
          ...('text' in feature ? { text: feature.text, txtcol: String(feature.sourceProperties.txtcol ?? ''), pressureLabel: isSurfacePressureLabel(feature) } : {}),
          ...('phase' in feature ? { phase: feature.phase } : {}) },
      })) });
      if (!accepted) return;
      shown = frame; visibility(true);
    })().catch(error => submission.reject(version, error));
  };
  return { update, get shown() { return shown; }, destroy() {
    destroyed = true; submission.destroy();
    clearResources();
  } };
}
