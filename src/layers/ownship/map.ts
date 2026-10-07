import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapLayerModule } from '../../core/map/layer';
import { LayerScope } from '../../core/layers/scope';
import type { OwnshipLayer } from './layer';
import { ownshipGeometry, sameOwnshipGeometry } from './geometry';
import { createFrameTask } from '../../core/graphics/frame-task';
import { createSourceSubmission } from '../../core/map/source-submission';

export const OWNSHIP_SOURCE = 'ownship';
export const OWNSHIP_LAYERS = ['ownship-accuracy', 'ownship-trace-halo', 'ownship-trace', 'ownship-position', 'ownship-aircraft'];
const ICON = 'ownship-airplane';
const BLUE = '#32b5ff';

export function createOwnshipMapLayer(product: OwnshipLayer, preserveInitialView = false): MapLayerModule<{ enabled: boolean }> {
  let map: MapLibreMap | undefined;
  let submission: ReturnType<typeof createSourceSubmission> | undefined;
  let scope: LayerScope | undefined;
  let rendered: ReturnType<OwnshipLayer['getSnapshot']> | undefined;
  let requested: typeof rendered;
  let pending = false, retried = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const visibility = (visible: boolean) => {
    // Constant paint opacity takes effect without reloading source tiles, unlike
    // layout visibility. Disable transitions so failed/live vectors disappear now.
    for (const id of OWNSHIP_LAYERS) if (map?.getLayer(id)) {
      if (id === 'ownship-accuracy') map.setPaintProperty(id, 'fill-opacity', visible ? 0.1 : 0);
      else if (id === 'ownship-position') {
        map.setPaintProperty(id, 'circle-opacity', visible ? 1 : 0);
        map.setPaintProperty(id, 'circle-stroke-opacity', visible ? 1 : 0);
      } else if (id === 'ownship-aircraft') map.setPaintProperty(id, 'icon-opacity', visible ? 1 : 0);
      else map.setPaintProperty(id, 'line-opacity', visible ? 1 : 0);
    }
  };
  const frame = createFrameTask(() => {
    if (!submission) return;
    const snapshot = product.getSnapshot();
    if (!pending && rendered && sameOwnshipGeometry(rendered, snapshot)) return;
    if (pending && requested && sameOwnshipGeometry(requested, snapshot)) return;
    if (!requested || !sameOwnshipGeometry(requested, snapshot)) {
      retried = false; clearTimeout(retry); retry = undefined;
    }
    requested = snapshot; pending = true;
    const owner = submission, version = owner.begin();
    void owner.submit(version, ownshipGeometry(snapshot)).then(accepted => {
      if (!accepted) return;
      pending = false;
      rendered = snapshot;
      if (sameOwnshipGeometry(snapshot, product.getSnapshot())) visibility(snapshot.enabled);
    }).catch(error => owner.reject(version, error));
  });
  const schedule = () => {
    const snapshot = product.getSnapshot();
    // Loss of validity clears the live vector immediately. Fresh callbacks in
    // the same frame share one geometry build; there is no idle render loop.
    if (!snapshot.enabled || snapshot.state !== 'tracking') {
      if (!rendered || !sameOwnshipGeometry(rendered, snapshot)) visibility(false);
      if (submission?.failed && retried && requested && sameOwnshipGeometry(requested, snapshot)) return;
      frame.flush();
    } else if (!rendered || !sameOwnshipGeometry(rendered, snapshot)) {
      if (submission?.failed && retried && requested && sameOwnshipGeometry(requested, snapshot)) return;
      frame.schedule();
    }
  };
  return {
    id: 'ownship', slot: 'ownship', foregroundLayerIds: OWNSHIP_LAYERS,
    mount(target) {
      map = target;
      scope = new LayerScope();
      scope.add(() => { map = undefined; submission = undefined; rendered = requested = undefined; pending = retried = false; });
      scope.add(() => { if (target.hasImage(ICON)) target.removeImage(ICON); });
      map.addImage(ICON, aircraftImage(), { pixelRatio: 2 });
      scope.add(() => { if (target.getSource(OWNSHIP_SOURCE)) target.removeSource(OWNSHIP_SOURCE); });
      map.addSource(OWNSHIP_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      submission = createSourceSubmission(target, OWNSHIP_SOURCE, () => {
        rendered = undefined; pending = false; visibility(false);
        if (!retried) {
          retried = true;
          retry = setTimeout(() => { retry = undefined; frame.flush(); }, 100);
        }
      });
      const attachedSubmission = submission;
      scope.add(() => attachedSubmission.destroy());
      scope.add(() => { clearTimeout(retry); retry = undefined; });
      for (const id of OWNSHIP_LAYERS) scope.add(() => { if (target.getLayer(id)) target.removeLayer(id); });
      map.addLayer({ id: 'ownship-accuracy', type: 'fill', source: OWNSHIP_SOURCE,
        filter: ['==', ['get', 'kind'], 'accuracy'],
        paint: { 'fill-color': ['case', ['get', 'live'], BLUE, '#8997a8'], 'fill-opacity': 0.1, 'fill-opacity-transition': { duration: 0, delay: 0 },
          'fill-outline-color': ['case', ['get', 'live'], BLUE, '#8997a8'] } });
      for (const [id, width, color] of [['ownship-trace-halo', 5, '#061a31'], ['ownship-trace', 2.5, BLUE]] as const) {
        map.addLayer({ id, type: 'line', source: OWNSHIP_SOURCE, filter: ['==', ['get', 'kind'], 'projection'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': color, 'line-width': width, 'line-opacity-transition': { duration: 0, delay: 0 } } });
      }
      map.addLayer({ id: 'ownship-position', type: 'circle', source: OWNSHIP_SOURCE,
        filter: ['all', ['==', ['get', 'kind'], 'aircraft'], ['==', ['get', 'track'], null]],
        paint: { 'circle-radius': 7, 'circle-color': ['case', ['get', 'live'], BLUE, '#8997a8'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
          'circle-opacity-transition': { duration: 0, delay: 0 }, 'circle-stroke-opacity-transition': { duration: 0, delay: 0 } } });
      map.addLayer({ id: 'ownship-aircraft', type: 'symbol', source: OWNSHIP_SOURCE,
        filter: ['all', ['==', ['get', 'kind'], 'aircraft'], ['!=', ['get', 'track'], null]],
        layout: { 'icon-image': ICON, 'icon-rotate': ['get', 'track'], 'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
        paint: { 'icon-opacity-transition': { duration: 0, delay: 0 } } });
      visibility(false);
      if (!ownshipGeometry(product.getSnapshot()).features.length) rendered = product.getSnapshot();
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
