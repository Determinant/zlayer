import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { FeatureCollectionResponse, GeoPointFeature, NavigationLayerId } from '@zlayer/contracts';
import { createRouteResolver, emptyRoutePlan } from '@zlayer/domain';
import { MapLayerHost, ROUTE_LINE_ANCHOR } from '../../src/core/map/layer';
import { createNavigationLayer } from '../../src/layers/navigation/layer';
import { DEFAULT_VISIBILITY } from '../../src/layers/navigation/definitions';
import { createSelectionMarkerLayer } from '../../src/layers/navigation/selection-marker';
import { createWaypointInspectionLayer } from '../../src/layers/navigation/waypoint-inspection';
import { createMetarLayer } from '../../src/layers/metar-taf/metar/layer';
import { MetarClient } from '../../src/layers/metar-taf/metar/client';
import { createRouteLayer } from '../../src/layers/routes/layer';
import { MapGestures } from '../../src/workspace/map/gestures';
import { createGpsService } from '../../src/core/gps/service';
import { createOwnshipLayer } from '../../src/layers/ownship/layer';
import { createOwnshipMapLayer } from '../../src/layers/ownship/map';
import { createTfrMapLayer } from '../../src/layers/notams/tfr-map';
import { createNavaidIdentificationLayer } from '../../src/layers/navigation/identification-layer';
import { createRulerLayer } from '../../src/layers/ruler/layer';
import { createRulerMapLayer } from '../../src/layers/ruler/map';
import '../../src/styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);
const center: [number, number] = [-122, 37];
const point = (id: string, properties: GeoPointFeature['properties']): GeoPointFeature => ({
  type: 'Feature', id, geometry: { type: 'Point', coordinates: center }, properties,
});
const airport = point('airport:KSFO', { kind: 'airport', ident: 'KSFO', icaoId: 'KSFO', facilityType: 'A', towered: true });
const navaid = point('navaid:CMA', { kind: 'navaid', ident: 'CMA', type: 'VOR/DME' });
const fix = point('fix:FIXIT', { kind: 'fix', ident: 'FIXIT', useCode: 'WP', charts: ['ENROUTE LOW'] });
const visual = point('vfr:VPONE', { kind: 'vfr-waypoint', ident: 'VPONE', useCode: 'VFR' });
const coordinate = point('coordinate:GPS', { kind: 'coordinate', ident: '370000N1220000W' });
const collection = (layer: NavigationLayerId, feature: GeoPointFeature): FeatureCollectionResponse => ({
  type: 'FeatureCollection', features: [feature], meta: { layer, revision: 'test', returned: 1, truncated: false },
});
const data = { airports: collection('airports', airport), navaids: collection('navaids', navaid),
  fixes: collection('fixes', fix), 'vfr-waypoints': collection('vfr-waypoints', visual) };
const navigation = createNavigationLayer(), marker = createSelectionMarkerLayer(), inspection = createWaypointInspectionLayer();
const reports = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: airport.geometry,
  properties: { id: 'KSFO', obsTime: Date.now() / 1000, fltcat: 'VFR', rawOb: 'KSFO TEST METAR' } }] };
const weather = createMetarLayer(new MetarClient(new URL('/fixture-metars', location.href), {
  storage: { getItem: () => JSON.stringify(reports), setItem() {} }, fetch: async () => Response.json(reports),
})).map;
const ownship = createOwnshipMapLayer(createOwnshipLayer(createGpsService()), true);
const route = createRouteLayer();
let plan = emptyRoutePlan(), weatherEnabled = true, annotationsEnabled = false;
const tfr = createTfrMapLayer(), identification = createNavaidIdentificationLayer();
const ruler = createRulerLayer(), rulerMap = createRulerMapLayer(ruler);
const errors: string[] = [];
const map = new MapLibreMap({ container: 'map', center, zoom: 12, fadeDuration: 0,
  attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true },
  style: { version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
    layers: [{ id: ROUTE_LINE_ANCHOR, type: 'background', paint: { 'background-color': '#314653' } }] } });
map.on('error', event => errors.push(event.error.message));
const host = new MapLayerHost(map, (id, error) => errors.push(`${id}: ${String(error)}`));
const modules = () => [ownship, marker, route, inspection, navigation, ...(weatherEnabled ? [weather] : []),
  ...(annotationsEnabled ? [tfr, identification, rulerMap] : [])];
navigation.update({ data, visibility: DEFAULT_VISIBILITY });
weather.update({ airports: data.airports, airportsVisible: true, enabled: true });
route.update({ route: plan });
ownship.update({ enabled: false });
let selected: GeoPointFeature | undefined, selectedPointId: string | undefined;
const select = (feature?: GeoPointFeature, pointId?: string) => {
  selected = feature; selectedPointId = pointId;
  host.update(navigation, { data, visibility: DEFAULT_VISIBILITY, priorityFixes: feature ? [feature] : [] });
  host.update(inspection, feature?.properties.kind === 'coordinate' ? feature : undefined);
  host.update(marker, feature);
};
new MapGestures(map, { route: () => plan, canEditRoute: () => false, interactiveLayerIds: () => host.interactiveLayerIds(),
  onSelect: select, preview() {}, onRouteLegInsert() {}, onRouteWaypointReplace() {}, onRouteWaypointRemove() {} });
map.on('load', () => { host.mount(modules()); document.body.dataset.ready = 'true'; });
const api = {
  map, errors,
  select: (ident?: string) => select([airport, navaid, fix, visual, coordinate].find(feature => feature.properties.ident === ident)),
  selected: () => ({ id: selected?.id, pointId: selectedPointId }),
  hits: () => map.queryRenderedFeatures(map.project(center), { layers: host.interactiveLayerIds() })
    .map(feature => ({ id: feature.properties.mapFeatureId, layer: feature.layer.id, source: feature.source, pointId: feature.properties.routePointId })),
  weather: (enabled: boolean) => {
    weatherEnabled = enabled;
    weather.update({ airports: data.airports, airportsVisible: true, enabled: true });
    host.reconcile(modules());
  },
  route: (enabled: boolean) => {
    plan = enabled ? createRouteResolver(Object.values(data))('CMA') : emptyRoutePlan();
    host.update(route, { route: plan });
  },
  ownship: (enabled: boolean) => host.update(ownship, { enabled }),
  annotations: (enabled: boolean) => {
    annotationsEnabled = enabled;
    const now = Date.now();
    tfr.update({ now, loading: false, snapshot: { schemaVersion: 1, source: 'FAA-TFR', checkedAt: now, notices: [{
      id: '6/9000', title: 'Overlapping TFR fixture', type: 'HAZARDS', facility: 'TST', state: 'CA',
      modifiedAt: now, detailCheckedAt: now, startsAt: now - 1000, endsAt: now + 3600_000, text: 'Synthetic test only',
      areas: [{ id: '1', name: 'Area A', lower: 'SFC', upper: '3000 ft MSL',
        windows: [{ startsAt: now - 1000, endsAt: now + 3600_000 }], geometry: { type: 'Polygon', coordinates: [
          [[-122.1, 36.9], [-121.9, 36.9], [-121.9, 37.1], [-122.1, 37.1], [-122.1, 36.9]],
        ] } }],
    }] } });
    identification.update({ point: { ...navaid, geometry: { type: 'Point', coordinates: [-122.03, 37] } },
      stations: [{ feature: { ...navaid, geometry: { type: 'Point', coordinates: [-121.97, 37] } },
        mon: false, radial: 270, distanceNm: 2.9, trueBearing: 270 }] });
    if (enabled) { ruler.open(); ruler.place([-122.03, 37]); ruler.place([-121.97, 37]); }
    else ruler.close();
    host.reconcile(modules());
  },
  pixel: () => {
    const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')!;
    const p = map.project(center), scale = canvas.width / canvas.clientWidth, pixel = new Uint8Array(4);
    gl.readPixels(Math.round(p.x * scale), canvas.height - Math.round(p.y * scale), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return Array.from(pixel).slice(0, 3);
  },
};
declare global { interface Window { selectionOrder: typeof api } }
window.selectionOrder = api;
