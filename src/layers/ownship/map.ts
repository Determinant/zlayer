import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { MapLayerModule } from '../../core/map/layer';
import { LayerScope } from '../../core/layers/scope';
import type { OwnshipLayer } from './layer';
import { ownshipGeometry, sameOwnshipGeometry } from './geometry';
import { createFrameTask } from '../../core/graphics/frame-task';

export const OWNSHIP_SOURCE = 'ownship';
export const OWNSHIP_LAYERS = ['ownship-accuracy', 'ownship-trace-halo', 'ownship-trace', 'ownship-position', 'ownship-aircraft'];
const ICON = 'ownship-airplane';
const BLUE = '#32b5ff';

export function createOwnshipMapLayer(product: OwnshipLayer, preserveInitialView = false): MapLayerModule<{ enabled: boolean }> {
  let map: MapLibreMap | undefined;
  let source: GeoJSONSource | undefined;
  let scope: LayerScope | undefined;
  let rendered: ReturnType<OwnshipLayer['getSnapshot']> | undefined;
  const sourceFailed = () => { rendered = undefined; };
  const frame = createFrameTask(() => {
    if (!map) return;
    const snapshot = product.getSnapshot();
    if (rendered && sameOwnshipGeometry(rendered, snapshot)) return;
    if (!source) return;
    void source.setData(ownshipGeometry(snapshot));
    rendered = snapshot;
  });
  const schedule = () => {
    const snapshot = product.getSnapshot();
    // Loss of validity clears the live vector immediately. Fresh callbacks in
    // the same frame share one geometry build; there is no idle render loop.
    if (!snapshot.enabled || snapshot.state !== 'tracking') {
      frame.flush();
    } else if (!rendered || !sameOwnshipGeometry(rendered, snapshot)) {
      frame.schedule();
    }
  };
  return {
    id: 'ownship', slot: 'ownship', foregroundLayerIds: OWNSHIP_LAYERS,
    mount(target) {
      map = target;
      scope = new LayerScope();
      scope.add(() => { map = undefined; source = undefined; rendered = undefined; });
      scope.add(() => { if (target.hasImage(ICON)) target.removeImage(ICON); });
      map.addImage(ICON, aircraftImage(), { pixelRatio: 2 });
      rendered = product.getSnapshot();
      scope.add(() => { if (target.getSource(OWNSHIP_SOURCE)) target.removeSource(OWNSHIP_SOURCE); });
      map.addSource(OWNSHIP_SOURCE, { type: 'geojson', data: ownshipGeometry(rendered) });
      source = map.getSource(OWNSHIP_SOURCE) as GeoJSONSource;
      const attachedSource = source;
      scope.add(() => attachedSource.off('error', sourceFailed));
      source.on('error', sourceFailed);
      for (const id of OWNSHIP_LAYERS) scope.add(() => { if (target.getLayer(id)) target.removeLayer(id); });
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
      scope.add(() => product.detach());
      scope.add(() => frame.cancel());
      scope.add(product.subscribe(schedule));
      product.attach({ centerOnFix: !preserveInitialView });
      preserveInitialView = true;
      schedule();
    },
    update({ enabled }) {
      if (!enabled) preserveInitialView = false;
      product.setEnabled(enabled);
    },
    unmount() {
      scope?.dispose(); scope = undefined;
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
