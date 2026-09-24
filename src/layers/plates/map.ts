import type { Map as MapLibreMap } from 'maplibre-gl';
import { PLATE_LAYER_ANCHOR, removeLayerResources, type MapLayerModule } from '../../core/map/layer';
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
  const sync = () => {
    if (!map) return;
    const next = product.getSnapshot().mapImage;
    if (next === image) return;
    removeLayerResources(map, [LAYER], [SOURCE]);
    image = next;
    if (!next) { fitted = undefined; return; }
    map.addSource(SOURCE, { type: 'canvas', canvas: next.canvas, animate: false, coordinates: next.coordinates });
    map.addLayer({ id: LAYER, type: 'raster', source: SOURCE,
      paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0 } }, PLATE_LAYER_ANCHOR);
    if (next !== fitted && !product.getSnapshot().mapImageRestored) {
      const [northwest, , southeast] = next.coordinates;
      map.fitBounds([northwest!, southeast!], { padding: 48, maxZoom: 12, duration: 500 });
    }
    fitted = next;
  };
  return {
    id: 'plates', slot: 'plates',
    mount(next: MapLibreMap) {
      map = next; image = undefined;
      unsubscribe = product.subscribe(sync);
      sync();
    },
    update() {},
    unmount() {
      unsubscribe?.(); unsubscribe = undefined;
      if (map) {
        removeLayerResources(map, [LAYER], [SOURCE]);
      }
      map = undefined; image = undefined;
    },
    imageAt(point: { x: number; y: number }): PlateMapImage | undefined {
      if (!map || !image) return undefined;
      const location = map.unproject([point.x, point.y]);
      return plateContains(image, [location.lng, location.lat]) ? image : undefined;
    },
  } satisfies MapLayerModule<void> & { imageAt: (point: { x: number; y: number }) => PlateMapImage | undefined };
}
