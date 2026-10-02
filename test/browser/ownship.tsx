import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Map, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { createOwnshipLayer, OwnshipStatus } from '../../src/layers/ownship';
import { createGpsCamera } from '../../src/workspace/map/gps-camera';
import { createGpsService } from '../../src/core/gps/service';
import { createOwnshipMapLayer, OWNSHIP_LAYERS, OWNSHIP_SOURCE } from '../../src/layers/ownship/map';
import { MapLayerHost } from '../../src/core/map/layer';
import '../../src/styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);
const product = createOwnshipLayer(createGpsService());
function Fixture() {
  const target = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const mapRef = useRef<Map>(null);
  const cameraRef = useRef<ReturnType<typeof createGpsCamera>>(null);
  const hostRef = useRef<MapLayerHost>(null);
  const adapterRef = useRef<ReturnType<typeof createOwnshipMapLayer>>(null);
  const [session, setSession] = useState(0);
  useEffect(() => {
    document.body.dataset.ready = 'false';
    const adapter = createOwnshipMapLayer(product);
    adapterRef.current = adapter;
    const map = new Map({ container: target.current!, center: [-122, 37], zoom: 11, attributionControl: false, fadeDuration: 0,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      style: { version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e3e8e8' } }] } });
    mapRef.current = map;
    const camera = createGpsCamera(map, product, false, () => {});
    cameraRef.current = camera;
    const host = new MapLayerHost(map, (_id, error) => setErrors(current => [...current, String(error)]));
    hostRef.current = host;
    map.on('error', event => setErrors(current => [...current, event.error.message]));
    map.on('load', () => { host.mount([adapter]); document.body.dataset.ready = 'true'; });
    const movement: number[] = [];
    let sourceUpdates = 0;
    map.on('dataloading', event => {
      if ('sourceId' in event && event.sourceId === OWNSHIP_SOURCE) sourceUpdates++;
    });
    map.on('move', () => movement.push(map.getCenter().lng));
    // Test-only access to the real renderer, not a production debug surface.
    window.ownshipFixture = {
      project: coordinates => map.project(coordinates),
      stats: async () => ({
        turnRate: product.getSnapshot().turnRate, displayTrack: product.getSnapshot().displayTrack, sourceUpdates,
        geometry: await (map.getSource(OWNSHIP_SOURCE) as GeoJSONSource).getData(),
        rendered: map.queryRenderedFeatures(undefined, { layers: OWNSHIP_LAYERS }).map(feature => feature.layer.id),
        bearing: map.getBearing(), center: map.getCenter().toArray(),
        alignment: map.getLayoutProperty('ownship-aircraft', 'icon-rotation-alignment'),
        rotation: map.getLayoutProperty('ownship-aircraft', 'icon-rotate'),
        moving: map.isMoving(),
        movement,
      }),
      camera: (options: { center?: [number, number]; bearing?: number; pitch?: number; zoom?: number }) => {
        map.jumpTo(options); movement.length = 0;
      },
    };
    return () => { camera.dispose(); host.unmount(); map.remove(); };
  }, [session]);
  useEffect(() => adapterRef.current?.update({ enabled }), [enabled]);
  return <main style={{ height: '100dvh', position: 'relative' }}>
    <div ref={target} style={{ position: 'absolute', inset: 0 }} />
    <div style={{ position: 'absolute', top: 12, left: 12, padding: 12, width: 300, background: '#13212deb', borderRadius: 10 }}>
      <OwnshipStatus layer={product} enabled={enabled} onToggle={() => setEnabled(value => !value)} />
      <button onClick={() => cameraRef.current?.setTrackUp(true)}>Rotate map</button>
      <button onClick={() => { cameraRef.current?.setTrackUp(false); mapRef.current?.jumpTo({ center: [-121.5, 37] }); }}>Pan away</button>
      <button onClick={() => hostRef.current?.mount([adapterRef.current!])}>Remount</button>
      <button onClick={() => setSession(value => value + 1)}>Replace map</button>
      <output data-testid="errors">{errors.join('\n')}</output>
    </div>
  </main>;
}
declare global { interface Window { ownshipFixture: {
  project: (coordinates: [number, number]) => { x: number; y: number };
  camera: (options: { center?: [number, number]; bearing?: number; pitch?: number; zoom?: number }) => void;
  stats: () => Promise<{
  turnRate: number | null; displayTrack: number | null; sourceUpdates: number;
  geometry: GeoJSON.GeoJSON; rendered: string[]; bearing: number; center: [number, number]; alignment: unknown; rotation: unknown;
  moving: boolean;
  movement: number[];
}> } } }
createRoot(document.getElementById('root')!).render(<Fixture />);
