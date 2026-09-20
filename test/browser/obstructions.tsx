import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Map, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { createRouteResolver } from '@zlayer/domain';
import type { FeatureCollectionResponse } from '@zlayer/contracts';
import { createObstructionLayer } from '../../src/layers/obstructions/map';
import { ObstructionControls, type ObstructionStatus } from '../../src/layers/obstructions';
import { OBSTRUCTION_LAYER, OBSTRUCTION_SOURCE } from '../../src/layers/obstructions/definitions';
import { createRouteLayer } from '../../src/layers/routes/layer';
import { MapLayerHost, ROUTE_LINE_ANCHOR } from '../../src/core/map/layer';
import '../../src/styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);
const navigation: FeatureCollectionResponse = { type: 'FeatureCollection', features: ['AAAA', 'BBBB', 'CCCC', 'DDDD'].map((ident, i) => ({
  type: 'Feature', id: ident, geometry: { type: 'Point', coordinates: [-122.35 + (i % 2) * 0.5, i < 2 ? 37.5 : 38] }, properties: { ident },
})), meta: { layer: 'airports', revision: '2026-09-03', returned: 4, truncated: false } };
const resolve = createRouteResolver([navigation]), planned = resolve('AAAA BBBB');
const parameters = new URLSearchParams(location.search);
const initial = parameters.get('route') === 'none' ? resolve('') : planned;

function Fixture() {
  const target = useRef<HTMLDivElement>(null), mapRef = useRef<Map | undefined>(undefined);
  const layerRef = useRef<ReturnType<typeof createObstructionLayer> | undefined>(undefined);
  const routeRef = useRef<ReturnType<typeof createRouteLayer> | undefined>(undefined);
  const [status, setStatus] = useState<ObstructionStatus>({ state: 'idle' });
  const [enabled, setEnabled] = useState(true), [route, setRoute] = useState(initial), [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    const map = new Map({ container: target.current!, center: [-122.12, 37.51],
      zoom: Number(parameters.get('zoom') ?? 10), attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true }, fadeDuration: 0,
      style: { version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#132333' } },
          { id: ROUTE_LINE_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } }] } });
    mapRef.current = map;
    map.on('idle', async () => {
      document.body.dataset.mapIdle = 'true';
      document.body.dataset.renderedObstructions = JSON.stringify(map.getLayer(OBSTRUCTION_LAYER)
        ? [...new Set(map.queryRenderedFeatures(undefined, { layers: [OBSTRUCTION_LAYER] }).map(feature => feature.id))] : []);
      const source = map.getSource(OBSTRUCTION_SOURCE) as GeoJSONSource | undefined;
      const data = await source?.getData();
      document.body.dataset.publishedObstructions = JSON.stringify(data?.type === 'FeatureCollection' ? data.features : []);
    });
    map.on('dataloading', () => {
      document.body.dataset.mapIdle = 'false';
      document.body.dataset.renderedObstructions = '[]';
      document.body.dataset.publishedObstructions = '[]';
    });
    map.on('movestart', () => { document.body.dataset.mapIdle = 'false'; });
    map.on('error', event => setErrors(current => [...current, event.error.message]));
    const layer = createObstructionLayer(setStatus); layerRef.current = layer;
    const routeLayer = createRouteLayer(); routeRef.current = routeLayer;
    const host = new MapLayerHost(map, (_id, error) => setErrors(current => [...current, String(error)]));
    map.on('load', () => {
      layer.update({ enabled: true, routes: [initial] }); routeLayer.update({ route: initial }); host.mount([layer, routeLayer]);
    });
    return () => { host.unmount(); map.remove(); };
  }, []);
  useEffect(() => { layerRef.current?.update({ enabled, routes: [route] }); routeRef.current?.update({ route }); }, [enabled, route]);
  return <main style={{ height: '100dvh', position: 'relative' }}>
    <div ref={target} style={{ position: 'absolute', inset: 0 }} />
    <div style={{ position: 'absolute', top: 12, left: 12, padding: 12, width: 295, background: '#101923ed', color: 'white', borderRadius: 10 }}>
      <ObstructionControls enabled={enabled} status={status} onToggle={() => setEnabled(value => !value)} />
      <button onClick={() => mapRef.current?.jumpTo({ zoom: 10 })}>VP detail</button>
      <button onClick={() => mapRef.current?.jumpTo({ zoom: 6.99 })}>Zoom out</button>
      <label>Map zoom <input type="number" step="0.01" defaultValue={parameters.get('zoom') ?? '10'}
        onChange={event => { if (event.target.value) mapRef.current?.jumpTo({ zoom: Number(event.target.value) }); }} /></label>
      <button onClick={() => setRoute(resolve('CCCC DDDD'))}>Move route</button>
      <button onClick={() => setRoute(resolve(''))}>Clear route</button>
      <button onClick={() => setRoute(planned)}>Restore route</button>
      <button onClick={() => { layerRef.current?.unmount(); layerRef.current?.mount(mapRef.current!); }}>Remount</button>
      <output data-state={status.state} data-count={status.count ?? 0} data-min-height={status.minHeightAglFt}>{status.state}</output>
      <pre data-testid="errors">{errors.join('\n')}</pre>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
