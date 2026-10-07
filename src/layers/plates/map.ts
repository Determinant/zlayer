import type { ErrorEvent, Map as MapLibreMap } from 'maplibre-gl';
import { PLATE_LAYER_ANCHOR, type MapLayerModule } from '../../core/map/layer';
import { LayerScope } from '../../core/layers/scope';
import { plateContains, type PlateMapImage } from './map-image';
import type { PlatesController } from './layer';

const SOURCE = 'plates-image';
const LAYER = 'plates-raster';

export function createPlateMapLayer(product: PlatesController, initiallyFitted?: PlateMapImage) {
  let map: MapLibreMap | undefined;
  let image: PlateMapImage | undefined;
  // An attachment restores rendering, not an already-consumed camera request.
  let fitted = initiallyFitted;
  let unsubscribe: (() => void) | undefined;
  const clear = () => {
    image = undefined;
    if (!map) return;
    const target = map, resources = new LayerScope();
    resources.add(() => { if (target.getSource(SOURCE)) target.removeSource(SOURCE); });
    resources.add(() => { if (target.getLayer(LAYER)) target.removeLayer(LAYER); });
    resources.dispose();
  };
  const failed = (next: PlateMapImage, error: unknown) => { clear(); product.mapRenderFailed(next, error); };
  const onError = (event: ErrorEvent & { sourceId?: string }) => {
    const next = product.getSnapshot().mapImage;
    if (event.sourceId === SOURCE && next) failed(next, event.error);
  };
  const sync = () => {
    if (!map) return;
    const { mapImage: next, mapRenderError } = product.getSnapshot();
    if (mapRenderError) return;
    if (next && next === image) return;
    clear();
    if (!next) { fitted = undefined; return; }
    try {
      map.addSource(SOURCE, { type: 'canvas', canvas: next.canvas, animate: false, coordinates: next.coordinates });
      if (product.getSnapshot().mapRenderError) { clear(); return; }
      map.addLayer({ id: LAYER, type: 'raster', source: SOURCE,
        paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0 } }, PLATE_LAYER_ANCHOR);
      if (product.getSnapshot().mapRenderError) { clear(); return; }
      image = next;
      if (next !== fitted && !product.getSnapshot().mapImageRestored) {
        const [northwest, , southeast] = next.coordinates;
        map.fitBounds([northwest!, southeast!], { padding: 48, maxZoom: 12, duration: 500 });
      }
      fitted = next;
    } catch (error) { failed(next, error); }
  };
  return {
    id: 'plates', slot: 'plates',
    mount(next: MapLibreMap) {
      map = next; image = undefined;
      map.on('error', onError);
      unsubscribe = product.subscribe(sync);
      product.retryMapRender();
      sync();
    },
    update() {},
    unmount() {
      unsubscribe?.(); unsubscribe = undefined;
      map?.off('error', onError);
      clear();
      map = undefined; image = undefined;
    },
    imageAt(point: { x: number; y: number }): PlateMapImage | undefined {
      if (!map || !image) return undefined;
      const location = map.unproject([point.x, point.y]);
      return plateContains(image, [location.lng, location.lat]) ? image : undefined;
    },
  } satisfies MapLayerModule<void> & { imageAt: (point: { x: number; y: number }) => PlateMapImage | undefined };
}
