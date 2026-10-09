import type { Map, ExpressionSpecification } from 'maplibre-gl';
import { createSourceSubmission } from '../../core/map/source-submission';
import { LayerScope } from '../../core/layers/scope';
import { WEATHER_LAYER_ANCHOR, type MapLayerModule } from '../../core/map/layer';
import { shadedGrid, type WeatherState, type WeatherController } from './controller';
import { mountGridMap } from './grids/map';
import { mountWindMap } from './grids/wind-map';
import { ADVISORY_COLORS } from './palette';
import { mountRadarMap } from './radar/map';
import { mountRadarMotionMap, MOTION_LAYERS } from './radar/motion-map';
import { mountProgsCoverageMap } from './progs/coverage-map';
import { mountProgsMap, SURFACE_LAYERS } from './progs/map';

const SOURCE = 'weather-awc-advisories';
export const ADVISORY_LAYERS = ['weather-awc-fills', 'weather-awc-line-halo', 'weather-awc-lines'];
const colors: ExpressionSpecification = ['match', ['get', 'hazard'],
  ['ICE', 'FZLVL', 'M_FZLVL'], ADVISORY_COLORS.icing, ['TURB', 'TURB-HI', 'TURB-LO'], ADVISORY_COLORS.turbulence,
  ['CONVECTIVE', 'TS'], ADVISORY_COLORS.convective, ['IFR', 'MT_OBSC'], ADVISORY_COLORS.ifr, ADVISORY_COLORS.other];
const lineWidth = 2;

export function createWeatherMap(controller: WeatherController): MapLayerModule<void> {
  let map: Map | undefined;
  let inputs: WeatherState | undefined;
  let previous = '', retry = -1;
  let submission: ReturnType<typeof createSourceSubmission> | undefined;
  let scope: LayerScope | undefined;
  let attempted: ReturnType<WeatherController['getSnapshot']>['products'] | undefined;
  let grids: ReturnType<typeof mountGridMap> | undefined;
  let winds: ReturnType<typeof mountWindMap> | undefined;
  let radar: ReturnType<typeof mountRadarMap> | undefined;
  let motion: ReturnType<typeof mountRadarMotionMap> | undefined;
  let coverage: ReturnType<typeof mountProgsCoverageMap> | undefined;
  let progs: ReturnType<typeof mountProgsMap> | undefined;
  const visible = (show: boolean) => {
    for (const id of ADVISORY_LAYERS) if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
  };
  const fail = (error: unknown) => {
    visible(false);
    controller.setAdvisoryDisplay({ loading: false, ids: [], error: `Advisory rendering failed: ${error instanceof Error ? error.message : String(error)}` });
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
    const state = controller.getSnapshot(), last = inputs;
    // Save before child publications: source acceptance can synchronously notify
    // this adapter again. Receipts must not rerun unrelated selection work.
    inputs = state;
    const selectionChanged = !last || last.preferences !== state.preferences ||
      last.selectedTime !== state.selectedTime || last.now !== state.now;
    const grid = shadedGrid(state), oldGrid = last && shadedGrid(last);
    if (selectionChanged || grid.data !== oldGrid?.data || grid.nearby !== oldGrid?.nearby ||
      grid.loading !== oldGrid?.loading || last?.forecastRetry !== state.forecastRetry) grids?.update();
    if (selectionChanged || last?.wind.data !== state.wind.data || last?.forecastRetry !== state.forecastRetry) winds?.update();
    if (selectionChanged || last?.coverage !== state.coverage || last?.progsRetry !== state.progsRetry) coverage?.update();
    if (selectionChanged || last?.progs.analysis.snapshot !== state.progs.analysis.snapshot ||
      last?.progs.forecast.snapshot !== state.progs.forecast.snapshot || last?.progsRetry !== state.progsRetry) progs?.update();
    if (selectionChanged || last?.radar.snapshot !== state.radar.snapshot || last?.radarRetry !== state.radarRetry) radar?.update();
    if (selectionChanged || last?.radar.snapshot !== state.radar.snapshot || last?.radarMotion.snapshot !== state.radarMotion.snapshot ||
      last?.radarRetry !== state.radarRetry || last?.radarDisplay.sites !== state.radarDisplay.sites) motion?.update();
    const snapshotsChanged = !last || (['gairmet', 'sigmet', 'cwa'] as const).some(product =>
      last.products[product].snapshot !== state.products[product].snapshot);
    if (!selectionChanged && !snapshotsChanged && last?.advisoryRetry === state.advisoryRetry) return;
    const advisories = controller.visibleAdvisories();
    const identity = advisories.map(a => a.id).join('|');
    const refreshed = attempted && (['gairmet', 'sigmet', 'cwa'] as const).some(product => attempted![product].snapshot !== state.products[product].snapshot);
    const source = submission!;
    const recover = source.failed && (retry !== state.advisoryRetry || refreshed);
    if (identity === previous && !recover) return;
    previous = identity; retry = state.advisoryRetry; attempted = state.products;
    const reset = source.failed;
    source.invalidate();
    visible(false);
    if (!identity) { controller.setAdvisoryDisplay({ loading: false, ids: [] }); return; }
    const version = source.begin();
    controller.setAdvisoryDisplay({ loading: true, ids: [] });
    void (async () => {
      if (reset) resetSource();
      const features = advisories.flatMap(a => {
        const properties = { id: a.id, hazard: a.hazard, product: a.product };
        return [{ type: 'Feature' as const, id: a.id, geometry: a.geometry, properties: { ...properties, outline: !a.outlineGeometry } },
          ...(a.outlineGeometry ? [{ type: 'Feature' as const, id: `${a.id}:outline`, geometry: a.outlineGeometry,
            properties: { ...properties, outline: true } }] : [])];
      });
      if (!await source.submit(version, { type: 'FeatureCollection', features })) return;
      visible(true);
      controller.setAdvisoryDisplay({ loading: false, ids: advisories.map(a => a.id) });
    })().catch(error => source.reject(version, error));
  };
  return { id: 'weather-awc', slot: 'weather',
    subscribeInputs: controller.subscribe,
    mount(next) {
      map = next;
      scope = new LayerScope();
      scope.add(() => controller.setAdvisoryDisplay({ loading: false, ids: [] }));
      scope.add(() => {
        submission = undefined; grids = undefined; winds = undefined; radar = undefined;
        motion = undefined; coverage = undefined; progs = undefined;
        inputs = undefined; previous = ''; attempted = undefined; retry = -1;
      });
      scope.add(() => { if (next.getSource(SOURCE)) next.removeSource(SOURCE); });
      for (const id of ADVISORY_LAYERS) scope.add(() => { if (next.getLayer(id)) next.removeLayer(id); });
      map.addSource(SOURCE, { type: 'geojson', attribution: 'NOAA / Aviation Weather Center',
        data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: ADVISORY_LAYERS[0]!, type: 'fill', source: SOURCE,
        layout: { visibility: 'none' },
        filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': colors, 'fill-opacity': 0.1, 'fill-antialias': false } }, WEATHER_LAYER_ANCHOR);
      map.addLayer({ id: ADVISORY_LAYERS[1]!, type: 'line', source: SOURCE,
        filter: ['==', ['get', 'outline'], true],
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': lineWidth + 1.5, 'line-opacity': 0.95 } }, WEATHER_LAYER_ANCHOR);
      map.addLayer({ id: ADVISORY_LAYERS[2]!, type: 'line', source: SOURCE,
        filter: ['==', ['get', 'outline'], true],
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': colors, 'line-width': lineWidth, 'line-opacity': 1 } }, WEATHER_LAYER_ANCHOR);
      submission = createSourceSubmission(map, SOURCE, fail);
      scope.add(submission.destroy);
      scope.add(() => controller.detach());
      controller.attach();
      grids = mountGridMap(map, controller, ADVISORY_LAYERS[0]!);
      scope.add(grids.destroy);
      // Both overlays mount lazily. Resolve the first Progs layer when radar
      // actually appears; Progs added later goes above it at the weather anchor.
      radar = mountRadarMap(map, controller, () => [...MOTION_LAYERS, ...SURFACE_LAYERS].find(id => next.getLayer(id)) ?? WEATHER_LAYER_ANCHOR);
      scope.add(radar.destroy);
      motion = mountRadarMotionMap(map, controller, () => SURFACE_LAYERS.find(id => next.getLayer(id)) ?? WEATHER_LAYER_ANCHOR);
      scope.add(motion.destroy);
      winds = mountWindMap(map, controller, ADVISORY_LAYERS[1]!);
      scope.add(winds.destroy);
      coverage = mountProgsCoverageMap(map, controller, ADVISORY_LAYERS[0]!);
      scope.add(coverage.destroy);
      progs = mountProgsMap(map, controller, WEATHER_LAYER_ANCHOR);
      scope.add(progs.destroy);
      controller.setPicker(point => {
        if (!map || !controller.getSnapshot().preferences.awcEnabled) return [];
        return [...new Set(map.queryRenderedFeatures([[point.x - 4, point.y - 4], [point.x + 4, point.y + 4]],
          { layers: [...ADVISORY_LAYERS, ...SURFACE_LAYERS.filter(id => map!.getLayer(id))] }).map(f => String(f.properties.id)))];
      });
      update();
    },
    update,
    unmount() {
      // Child cleanup can publish status synchronously; revoke parent updates first.
      map = undefined;
      scope?.dispose(); scope = undefined;
    },
  };
}
