import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { type MapLayerModule, removeLayerResources } from '../../core/map/layer';
import type { OwnshipLayer } from './layer';
import { ownshipGeometry } from './geometry';

export const OWNSHIP_SOURCE = 'ownship';
export const OWNSHIP_LAYERS = ['ownship-accuracy', 'ownship-trace-halo', 'ownship-trace', 'ownship-position', 'ownship-aircraft'];
const ICON = 'ownship-airplane';
const BLUE = '#32b5ff';

export function createOwnshipMapLayer(product: OwnshipLayer, preserveInitialView = false): MapLayerModule<{ enabled: boolean }> {
  let map: MapLibreMap | undefined;
  let unsubscribe: (() => void) | undefined;
  let lastCenter = product.getSnapshot().centerRequest;
  let firstFix = true;
  const render = () => {
    if (!map) return;
    const snapshot = product.getSnapshot();
    (map.getSource(OWNSHIP_SOURCE) as GeoJSONSource | undefined)?.setData(ownshipGeometry(snapshot));
    // A restored workspace keeps its camera through the first automatic GPS fix.
    // Subsequent explicit centering requests and enabling GPS still work normally.
    if (preserveInitialView && snapshot.enabled && snapshot.state === 'tracking' && snapshot.fix) {
      preserveInitialView = false;
      firstFix = false;
      lastCenter = snapshot.centerRequest;
    }
    if (snapshot.enabled && snapshot.state === 'tracking' && snapshot.fix && (firstFix || snapshot.centerRequest !== lastCenter)) {
      // Select the nearest world copy when the map has crossed the dateline.
      const [lng, lat] = snapshot.fix.coordinates;
      const longitude = lng + 360 * Math.round((map.getCenter().lng - lng) / 360);
      map.easeTo({ center: [longitude, lat], zoom: Math.max(map.getZoom(), 9), duration: 500 });
      firstFix = false;
    }
    lastCenter = snapshot.centerRequest;
  };
  return {
    id: 'ownship', slot: 'ownship', foregroundLayerIds: OWNSHIP_LAYERS,
    mount(target) {
      map = target;
      map.addImage(ICON, aircraftImage(), { pixelRatio: 2 });
      map.addSource(OWNSHIP_SOURCE, { type: 'geojson', data: ownshipGeometry(product.getSnapshot()) });
      map.addLayer({ id: 'ownship-accuracy', type: 'fill', source: OWNSHIP_SOURCE,
        filter: ['==', ['get', 'kind'], 'accuracy'],
        paint: { 'fill-color': ['case', ['get', 'live'], BLUE, '#8997a8'], 'fill-opacity': 0.1,
          'fill-outline-color': ['case', ['get', 'live'], BLUE, '#8997a8'] } });
      for (const [id, width, color] of [['ownship-trace-halo', 5, '#061a31'], ['ownship-trace', 2.5, BLUE]] as const) {
        map.addLayer({ id, type: 'line', source: OWNSHIP_SOURCE, filter: ['==', ['get', 'kind'], 'projection'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': color, 'line-width': width } });
      }
      map.addLayer({ id: 'ownship-position', type: 'circle', source: OWNSHIP_SOURCE,
        filter: ['all', ['==', ['get', 'kind'], 'aircraft'], ['==', ['get', 'track'], null]],
        paint: { 'circle-radius': 7, 'circle-color': ['case', ['get', 'live'], BLUE, '#8997a8'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'ownship-aircraft', type: 'symbol', source: OWNSHIP_SOURCE,
        filter: ['all', ['==', ['get', 'kind'], 'aircraft'], ['!=', ['get', 'track'], null]],
        layout: { 'icon-image': ICON, 'icon-rotate': ['get', 'track'], 'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
      unsubscribe = product.subscribe(render);
      product.attach();
      render();
    },
    update({ enabled }) {
      if (!enabled) preserveInitialView = false;
      product.setEnabled(enabled);
    },
    unmount() {
      unsubscribe?.();
      unsubscribe = undefined;
      product.detach();
      if (map) {
        removeLayerResources(map, OWNSHIP_LAYERS, [OWNSHIP_SOURCE]);
        if (map.hasImage(ICON)) map.removeImage(ICON);
      }
      map = undefined;
    },
  };
}

function aircraftImage(): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 88;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  context.scale(2, 2);
  context.translate(22, 22);
  context.beginPath();
  // The nose points up; rotation is a true track in the map's coordinate frame.
  for (const [index, [x, y]] of [[0, -18], [3, -13], [3, -4], [17, 4], [17, 8], [3, 4],
    [3, 12], [8, 15], [8, 18], [0, 16], [-8, 18], [-8, 15], [-3, 12], [-3, 4],
    [-17, 8], [-17, 4], [-3, -4], [-3, -13]].entries()) {
    if (index === 0) context.moveTo(x!, y!); else context.lineTo(x!, y!);
  }
  context.closePath();
  context.lineJoin = 'round';
  context.strokeStyle = '#061a31'; context.lineWidth = 4; context.stroke();
  context.strokeStyle = '#fff'; context.lineWidth = 2; context.stroke();
  context.fillStyle = BLUE; context.fill();
  return context.getImageData(0, 0, 88, 88);
}
