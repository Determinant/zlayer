import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Map, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { createRouteResolver } from '@zlayer/domain';
import type { CatalogResponse, FeatureCollectionResponse } from '@zlayer/contracts';
import { createTerrainLayer } from '../../src/layers/terrain/map';
import { TerrainControls, TerrainLegend, type TerrainCoverage, type TerrainStatus } from '../../src/layers/terrain';
import { createRouteLayer } from '../../src/layers/routes/layer';
import { MapLayerHost, TERRAIN_LAYER_ANCHOR, ROUTE_LINE_ANCHOR } from '../../src/core/map/layer';
import '../../src/styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);
const navigation: FeatureCollectionResponse = { type: 'FeatureCollection', features: ['AAAA', 'BBBB', 'CCCC'].map((ident, i) => ({
  type: 'Feature', id: ident, geometry: { type: 'Point', coordinates: [-122.35 + i * 0.25, 37.5 - (i === 2 ? 0.3 : 0)] }, properties: { ident },
})), meta: { layer: 'airports', revision: '2026-09-03', returned: 3, truncated: false } };
const resolve = createRouteResolver([navigation]);
const initialRoute = resolve('AAAA BBBB CCCC');
const initialCatalog: CatalogResponse = { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-03T00:00:00Z',
  charts: [], navigation: [], weather: [] };

declare global { interface Window { terrainMapAudit: { map: Map; refreshCatalog: () => void } } }

function Fixture() {
  const target = useRef<HTMLDivElement>(null), mapRef = useRef<Map | undefined>(undefined);
  const layerRef = useRef<ReturnType<typeof createTerrainLayer> | undefined>(undefined);
  const routeLayerRef = useRef<ReturnType<typeof createRouteLayer> | undefined>(undefined);
  const [status, setStatus] = useState<TerrainStatus>({ state: 'idle', interval: 1000 });
  const [enabled, setEnabled] = useState(true);
  const [coverage, setCoverage] = useState<TerrainCoverage>('route');
  const [altitude, setAltitude] = useState<number | null>(null);
  const [route, setRoute] = useState(initialRoute);
  const [catalog, setCatalog] = useState(initialCatalog);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    const map = new Map({ container: target.current!, center: [-122.12, 37.42],
      zoom: Number(new URLSearchParams(location.search).get('zoom') ?? 9),
      attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true },
      style: { version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eeeae1' } },
          { id: TERRAIN_LAYER_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } },
          { id: ROUTE_LINE_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } }] } });
    mapRef.current = map;
    window.terrainMapAudit = { map, refreshCatalog: () => setCatalog(previous => ({ ...previous,
      generatedAt: new Date(Date.parse(previous.generatedAt) + 1000).toISOString() })) };
    map.on('idle', async () => {
      document.body.dataset.mapIdle = 'true';
      document.body.dataset.mapCamera = JSON.stringify([map.getCenter().lng, map.getCenter().lat, map.getZoom()]);
      const terrainSource = map.getStyle().sources['route-terrain'];
      document.body.dataset.terrainSource = terrainSource?.type === 'raster-dem' ? terrainSource.tiles?.[0] ?? '' : '';
      document.body.dataset.contourFeatures = String(map.getLayer('route-terrain-outlines')
        ? map.queryRenderedFeatures(undefined, { layers: ['route-terrain-outlines'] }).length : 0);
      const order = map.getStyle().layers.map(layer => layer.id);
      document.body.dataset.terrainLabelsAboveRoute = String(['route-line-halo', 'route-line',
        'route-waypoint-halos', 'route-waypoints', 'route-insert-preview'].every(id =>
        order.indexOf('route-terrain-contour-labels') > order.indexOf(id) && order.indexOf(id) >= 0));
      document.body.dataset.terrainLabelsBelowWaypoints = String(
        order.indexOf('route-terrain-contour-labels') < order.indexOf('route-waypoint-labels'));
      const source = map.getSource('route-terrain-contours') as GeoJSONSource | undefined;
      const data = await source?.getData();
      document.body.dataset.publishedContours = String(data?.type === 'FeatureCollection' ? data.features.length : 0);
    });
    map.on('dataloading', () => { document.body.dataset.mapIdle = 'false'; });
    let styleUpdates = 0;
    map.on('styledata', () => {
      document.body.dataset.mapIdle = 'false';
      document.body.dataset.styleUpdates = String(++styleUpdates);
    });
    let contourUpdates = 0;
    map.on('sourcedataloading', event => {
      if (event.sourceId === 'route-terrain-contours' && !event.tile) {
        document.body.dataset.contourUpdates = String(++contourUpdates);
      }
    });
    map.on('movestart', () => { document.body.dataset.mapIdle = 'false'; });
    const layer = createTerrainLayer(setStatus); layerRef.current = layer;
    const routeLayer = createRouteLayer(); routeLayerRef.current = routeLayer;
    const host = new MapLayerHost(map, (_id, error) => setErrors(current => [...current, String(error)]));
    map.on('error', event => setErrors(current => [...current, event.error.message]));
    map.on('load', () => {
      layer.update({ enabled: true, routes: [initialRoute], catalog: initialCatalog });
      routeLayer.update({ route: initialRoute });
      host.mount([layer, routeLayer]);
      document.body.dataset.ready = 'true';
    });
    return () => { host.unmount(); map.remove(); };
  }, []);
  useEffect(() => {
    layerRef.current?.update({ enabled, routes: [route], altitude, coverage, catalog });
    document.body.dataset.terrainCatalog = catalog.generatedAt;
  }, [enabled, route, altitude, coverage, catalog]);
  useEffect(() => {
    routeLayerRef.current?.update({ route });
  }, [route]);
  return <main style={{ height: '100dvh', position: 'relative' }}>
    <div ref={target} style={{ position: 'absolute', inset: 0 }} />
    <div style={{ position: 'absolute', top: 12, left: 12, padding: 12, width: 290, background: '#13212deb', color: 'white', borderRadius: 10 }}>
      <TerrainControls enabled={enabled} status={status} onToggle={() => setEnabled(value => !value)}
        coverage={coverage} onCoverageChange={setCoverage} />
      <button onClick={() => mapRef.current?.jumpTo({ zoom: 11 })}>Detail</button>
      <button onClick={() => mapRef.current?.jumpTo({ zoom: 9 })}>Overview</button>
      <button onClick={() => mapRef.current?.jumpTo({ zoom: 7.5 })}>Zoom out</button>
      <button onClick={() => mapRef.current?.jumpTo({ center: [-110, 37.42] })}>Pan away</button>
      <button onClick={() => mapRef.current?.jumpTo({ center: [-122.12, 37.42] })}>Return to route</button>
      <button onClick={() => {
        const map = mapRef.current;
        if (map) map.jumpTo({ zoom: map.getZoom() + 0.2 });
      }}>Small zoom in</button>
      <button onClick={() => setRoute(resolve(''))}>Clear route</button>
      <button onClick={() => setRoute(initialRoute)}>Restore route</button>
      <button onClick={() => { layerRef.current?.unmount(); layerRef.current?.mount(mapRef.current!); }}>Remount</button>
      <output data-state={status.state}>{status.state}</output>
      <pre data-testid="errors">{errors.join('\n')}</pre>
    </div>
    <TerrainLegend enabled={enabled} onToggle={() => setEnabled(value => !value)}
      status={status} altitude={altitude} onAltitudeChange={setAltitude}
      coverage={coverage} onCoverageChange={setCoverage} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
