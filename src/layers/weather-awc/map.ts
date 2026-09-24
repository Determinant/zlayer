import type { Map, GeoJSONSource, ErrorEvent, ExpressionSpecification } from 'maplibre-gl';
import { WEATHER_LAYER_ANCHOR, type MapLayerModule } from '../../core/map/layer';
import type { WeatherController } from './controller';
import { mountGridMap } from './grids/map';
import { mountWindMap } from './grids/wind-map';
import { ADVISORY_COLORS } from './palette';
import { mountRadarMap } from './radar/map';
import { mountRadarMotionMap, MOTION_LAYERS } from './radar/motion-map';
import { mountProgsMap, SURFACE_LAYERS } from './progs/map';

const SOURCE = 'weather-awc-advisories';
export const ADVISORY_LAYERS = ['weather-awc-fills', 'weather-awc-line-halo', 'weather-awc-lines'];
const colors: ExpressionSpecification = ['match', ['get', 'hazard'],
  ['ICE', 'FZLVL', 'M_FZLVL'], ADVISORY_COLORS.icing, ['TURB', 'TURB-HI', 'TURB-LO'], ADVISORY_COLORS.turbulence,
  ['CONVECTIVE', 'TS'], ADVISORY_COLORS.convective, ['IFR', 'MT_OBSC'], ADVISORY_COLORS.ifr, ADVISORY_COLORS.other];
const lineWidth = 2;

export function createWeatherMap(controller: WeatherController): MapLayerModule<void> {
  let map: Map | undefined;
  let previous = '', revision = 0, retry = -1, failed = false;
  let attempted: ReturnType<WeatherController['getSnapshot']>['products'] | undefined;
  let grids: ReturnType<typeof mountGridMap> | undefined;
  let winds: ReturnType<typeof mountWindMap> | undefined;
  let radar: ReturnType<typeof mountRadarMap> | undefined;
  let motion: ReturnType<typeof mountRadarMotionMap> | undefined;
  let progs: ReturnType<typeof mountProgsMap> | undefined;
  const visible = (show: boolean) => {
    for (const id of ADVISORY_LAYERS) if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
  };
  const fail = (error: unknown) => {
    revision++; failed = true; visible(false);
    controller.setAdvisoryDisplay({ loading: false, ids: [], error: `Advisory rendering failed: ${error instanceof Error ? error.message : String(error)}` });
  };
  const onError = (event: ErrorEvent & { sourceId?: string }) => {
    if (map && previous && event.sourceId === SOURCE) fail(event.error);
  };
  const resetSource = () => {
    // Preserve each insertion point: wind barbs sit between advisory layers,
    // and radar/Progs may have appeared since these layers first mounted.
    const layers = map!.getStyle().layers;
    const saved = ADVISORY_LAYERS.map(id => {
      const index = layers.findIndex(layer => layer.id === id);
      return { layer: layers[index]!, before: layers[index + 1]?.id };
    });
    for (const id of [...ADVISORY_LAYERS].reverse()) map!.removeLayer(id);
    map!.removeSource(SOURCE);
    map!.addSource(SOURCE, { type: 'geojson', attribution: 'NOAA / Aviation Weather Center', data: { type: 'FeatureCollection', features: [] } });
    for (const { layer, before } of saved.reverse()) map!.addLayer(layer, before);
  };
  const update = () => {
    if (!map) return;
    grids?.update();
    winds?.update();
    progs?.update();
    radar?.update();
    motion?.update();
    const advisories = controller.visibleAdvisories();
    const identity = advisories.map(a => a.id).join('|');
    const state = controller.getSnapshot();
    const refreshed = attempted && (['gairmet', 'sigmet', 'cwa'] as const).some(product => attempted![product].snapshot !== state.products[product].snapshot);
    const recover = failed && (retry !== state.advisoryRetry || refreshed);
    if (identity === previous && !recover) return;
    previous = identity; retry = state.advisoryRetry; attempted = state.products;
    const version = ++revision, current = map;
    visible(false);
    if (!identity) { controller.setAdvisoryDisplay({ loading: false, ids: [] }); return; }
    controller.setAdvisoryDisplay({ loading: true, ids: [] });
    void (async () => {
      if (failed) { failed = false; resetSource(); }
      const features = advisories.map(a => ({ type: 'Feature' as const, id: a.id,
        geometry: a.geometry, properties: { id: a.id, hazard: a.hazard, product: a.product } }));
      await (current.getSource(SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features });
      if (map !== current || version !== revision) return;
      visible(true);
      controller.setAdvisoryDisplay({ loading: false, ids: advisories.map(a => a.id) });
    })().catch(error => { if (map === current && version === revision) fail(error); });
  };
  return { id: 'weather-awc', slot: 'weather',
    subscribeInputs: controller.subscribe,
    mount(next) {
      map = next;
      map.addSource(SOURCE, { type: 'geojson', attribution: 'NOAA / Aviation Weather Center',
        data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: ADVISORY_LAYERS[0]!, type: 'fill', source: SOURCE,
        layout: { visibility: 'none' },
        filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': colors, 'fill-opacity': 0.1 } }, WEATHER_LAYER_ANCHOR);
      map.addLayer({ id: ADVISORY_LAYERS[1]!, type: 'line', source: SOURCE,
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': lineWidth + 1.5, 'line-opacity': 0.95 } }, WEATHER_LAYER_ANCHOR);
      map.addLayer({ id: ADVISORY_LAYERS[2]!, type: 'line', source: SOURCE,
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': colors, 'line-width': lineWidth, 'line-opacity': 1 } }, WEATHER_LAYER_ANCHOR);
      map.on('error', onError);
      controller.attach();
      grids = mountGridMap(map, controller, ADVISORY_LAYERS[0]!);
      // Both overlays mount lazily. Resolve the first Progs layer when radar
      // actually appears; Progs added later goes above it at the weather anchor.
      radar = mountRadarMap(map, controller, () => [...MOTION_LAYERS, ...SURFACE_LAYERS].find(id => next.getLayer(id)) ?? WEATHER_LAYER_ANCHOR);
      motion = mountRadarMotionMap(map, controller, () => SURFACE_LAYERS.find(id => next.getLayer(id)) ?? WEATHER_LAYER_ANCHOR);
      winds = mountWindMap(map, controller, ADVISORY_LAYERS[1]!);
      progs = mountProgsMap(map, controller, WEATHER_LAYER_ANCHOR);
      controller.setPicker(point => {
        if (!map || !controller.getSnapshot().preferences.awcEnabled) return [];
        return [...new Set(map.queryRenderedFeatures([[point.x - 4, point.y - 4], [point.x + 4, point.y + 4]],
          { layers: [...ADVISORY_LAYERS, ...SURFACE_LAYERS.filter(id => map!.getLayer(id))] }).map(f => String(f.properties.id)))];
      });
      update();
    },
    update,
    unmount() {
      revision++;
      map?.off('error', onError);
      grids?.destroy(); grids = undefined;
      winds?.destroy(); winds = undefined;
      radar?.destroy(); radar = undefined;
      motion?.destroy(); motion = undefined;
      progs?.destroy(); progs = undefined;
      controller.detach();
      if (map) {
        for (const id of [...ADVISORY_LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SOURCE)) map.removeSource(SOURCE);
      }
      map = undefined; previous = ''; attempted = undefined; failed = false; retry = -1;
      controller.setAdvisoryDisplay({ loading: false, ids: [] });
    },
  };
}
