import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { removeLayerResources } from '../../core/map/layer';
import { REFERENCE_LINE_HALO, REFERENCE_LINE_PAINT } from '../../core/map/reference-line';
import { gripPosition, type ScreenPoint, type ScreenRect } from './handles';
import { rulerPath, type Coordinate } from './measurement';
import type { RulerEndpoint, RulerSnapshot } from './layer';

const SOURCE = 'ruler-measurement';
const LAYERS = ['ruler-halo', 'ruler-line'];
const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string>) {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

export function createRulerRenderer(map: MapLibreMap) {
  map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: LAYERS[0]!, type: 'line', source: SOURCE, ...REFERENCE_LINE_HALO });
  map.addLayer({ id: LAYERS[1]!, type: 'line', source: SOURCE,
    paint: REFERENCE_LINE_PAINT });
  const root = document.createElement('div');
  root.className = 'ruler-overlay';
  const drawing = svg('svg', { class: 'ruler-endpoints', 'aria-hidden': 'true' });
  root.append(drawing);
  const handles = (['start', 'end'] as const).map((endpoint, i) => {
    const leader = svg('path', { class: 'ruler-leader' });
    const target = svg('path', { class: 'ruler-crosshair',
      d: 'M-11 0H-4M4 0H11M0-11V-4M0 4V11' });
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ruler-grip';
    button.dataset.endpoint = endpoint;
    button.textContent = i ? 'B' : 'A';
    button.setAttribute('aria-label', `Move ${endpoint} point ${i ? 'B' : 'A'}`);
    button.title = 'Drag to move · arrow keys to adjust';
    drawing.append(leader, target);
    root.append(button);
    return { endpoint, button, target, leader, anchor: { x: 0, y: 0 }, grip: { x: 0, y: 0 } };
  });
  map.getContainer().append(root);
  let previousStart: Coordinate | null = null, previousEnd: Coordinate | null = null;
  const project = (coordinate: Coordinate) => map.project([
    coordinate[0] + 360 * Math.round((map.getCenter().lng - coordinate[0]) / 360), coordinate[1],
  ]);
  return {
    root, handles, project,
    draw(state: RulerSnapshot, obstacles: ScreenRect[], locked?: { endpoint: RulerEndpoint; offset: ScreenPoint }) {
      root.hidden = !state.active;
      root.classList.toggle('is-touch', state.touch);
      const start = state.active ? state.start : null, end = state.active ? state.end : null;
      if (start !== previousStart || end !== previousEnd) {
        const coordinates = start && end ? rulerPath(start, end) : [];
        (map.getSource(SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: coordinates.length > 1
          ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : [] });
        previousStart = start; previousEnd = end;
      }
      if (!state.active) return;
      const width = map.getContainer().clientWidth, height = map.getContainer().clientHeight;
      const anchors = [start, end].map(point => point ? project(point) : null);
      let occupied: ScreenPoint | null = null;
      // Lay out the grabbed handle first so the other one can avoid it.
      for (const handle of [...handles].sort((a, b) => Number(b.endpoint === locked?.endpoint) - Number(a.endpoint === locked?.endpoint))) {
        const index = handle.endpoint === 'start' ? 0 : 1, anchor = anchors[index];
        const visible = !!anchor && anchor.x >= 0 && anchor.y >= 0 && anchor.x <= width && anchor.y <= height;
        handle.button.hidden = !visible;
        handle.target.style.display = handle.leader.style.display = visible ? '' : 'none';
        if (!visible || !anchor) continue;
        const grip: ScreenPoint = locked?.endpoint === handle.endpoint
          ? { x: anchor.x + locked.offset.x, y: anchor.y + locked.offset.y }
          : gripPosition(anchor, anchors[1 - index] ?? null, occupied, width, height, obstacles, state.touch);
        handle.anchor = anchor; handle.grip = grip;
        occupied = grip;
        handle.button.style.left = `${grip.x}px`;
        handle.button.style.top = `${grip.y}px`;
        handle.button.classList.toggle('is-provisional', handle.endpoint === 'end' && state.provisional);
        handle.target.setAttribute('transform', `translate(${anchor.x} ${anchor.y})`);
        handle.leader.setAttribute('d', `M${anchor.x} ${anchor.y}L${grip.x} ${grip.y}`);
      }
    },
    destroy() {
      root.remove();
      removeLayerResources(map, LAYERS, [SOURCE]);
    },
  };
}
