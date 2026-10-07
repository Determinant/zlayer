import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Map, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { CatalogResponse } from '@zlayer/contracts';
import { createGlidePlugin } from '../../src/layers/glide/plugin';
import { MapLayerHost } from '../../src/core/map/layer';
import { LayerPanels } from '../../src/core/layers/panels';
import { EdgePanels } from '../../src/core/ui/edge-panels';
import { PANEL_LAYOUT } from '../../src/workspace/panel-layout';
import { useLayerSnapshot } from '../../src/core/layers/use-snapshot';
import { emptyRoutePlan, type RoutePlan } from '@zlayer/domain';
import { PluginRegistry } from '../../src/core/layers/bridge';
import { createLayerInput, createLayerStore } from '../../src/core/layers/store';
import type { RoutesApi } from '../../src/layers/routes/public';
import type { OwnshipApi } from '../../src/layers/ownship/public';
import type { GpsSnapshot } from '../../src/core/gps/service';
import { project, type Point } from '../../src/core/geo/route-corridor';
import { createLandingDisplayWorker } from '../../src/layers/glide/landing-display';
import { createLandingRasterWorker } from '../../src/layers/glide/landing-raster';
import type { GlideApi } from '../../src/layers/glide/public';
import type { MapContextAction, MapSelectionInput, NearbyFeature } from '../../src/core/map/selection';
import { createSelectionContribution } from '../../src/workspace/map/selection';
import { NearbyFeaturePicker } from '../../src/workspace/nearby-feature-picker';
import '../../src/styles.css';
import '../../src/shell/map-edge-tools.css';
import 'maplibre-gl/dist/maplibre-gl.css';
setWorkerUrl(workerUrl);
const glideRasterAudit = { display: createLandingDisplayWorker, raster: createLandingRasterWorker, project };
declare global { interface Window { glideRasterAudit: typeof glideRasterAudit } }
window.glideRasterAudit = glideRasterAudit;
const catalog: CatalogResponse = { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-03T00:00:00Z', charts: [], weather: [],
  navigation: [{ id: 'airports', title: 'Airports', count: 3, sourceCount: 3, minZoom: 0, url: '/chart-data/2026-09-03/nav/airports.geojson' }] };
declare global { interface Window { glideAudit: { map: Map; remount(): void; route(coordinates: Point[] | null): void; ownship(coordinates: Point | null, state?: GpsSnapshot['state']): void; provider(id: 'routes' | 'ownship', enabled: boolean): void } } }
function Fixture() {
  const target = useRef<HTMLDivElement>(null);
  const [plugin] = useState(createGlidePlugin);
  const [preferences, setPreferences] = useState(plugin.preferences.read);
  const [active, setActive] = useState<string | null>('glide');
  const status = useLayerSnapshot(plugin.status);
  const [errors, setErrors] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ features: NearbyFeature[]; point: { x: number; y: number }; actions: MapContextAction[] }>();
  useLayoutEffect(() => plugin.input.set({ ...preferences, catalog, change: patch => setPreferences(current => {
    const next = { ...current, ...patch }; plugin.preferences.write(next); return next;
  }) }));
  useEffect(() => {
    const map = new Map({ container: target.current!, center: [-119.78, 34.43], zoom: 9.2, attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true }, style: { version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eeeae1' } }] } });
    const displayed = createLayerStore<readonly RoutePlan[]>([{ ...emptyRoutePlan(), approachExtensions: [[[-120.1, 34.43], [-119.4, 34.43]]] }]);
    const position = createLayerStore<GpsSnapshot & { enabled: boolean }>({ enabled: true, state: 'acquiring', fix: null });
    const registry = new PluginRegistry<{ glide: GlideApi; routes: RoutesApi; ownship: OwnshipApi }>();
    const connections = {
      glide: registry.registration('glide', plugin),
      routes: registry.registration('routes', { publicApi: scope => ({
        plan: scope.store(createLayerStore(emptyRoutePlan())), displayedRoutes: scope.store(displayed),
        preview: scope.store(createLayerStore(undefined)), editing: scope.store(createLayerStore(undefined)),
        actions: { insert() {}, replace() {}, remove() {} },
      }) }),
      ownship: registry.registration('ownship', { publicApi: scope => ({ position: scope.store(position) }) }),
    };
    for (const connection of Object.values(connections)) connection.activate();
    const routeData = (coordinates: Point[]): GeoJSON.Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } });
    const selectionInput = createLayerInput<MapSelectionInput>();
    selectionInput.set({ resolveFeature: feature => feature, onSelect: () => setMenu(undefined),
      onChooseNearby: (features, point, actions = []) => setMenu({ features, point, actions }), onCloseNearby: () => setMenu(undefined) });
    const selection = createSelectionContribution(selectionInput, scope => registry.forScope(scope), {
      map, signal: new AbortController().signal, preserveView: true, interactiveLayerIds: () => [], occupiedRects: () => [], targetBearing: () => 0,
      run: (_id, action) => action(), reportError: error => setErrors(current => [...current, String(error)]),
    });
    const host = new MapLayerHost(map, (_id, error) => setErrors(current => [...current, String(error)]));
    let alive = true;
    map.on('error', event => setErrors(current => [...current, event.error.message]));
    map.on('load', () => { void plugin.mapContribution.load().then(modules => {
      if (!alive) return;
      host.mount([...modules, selection]);
      map.addSource('fixture-route', { type: 'geojson', data: routeData([[-120.1, 34.43], [-119.4, 34.43]]) });
      // Keep this context line outside the green/purple heat-pixel probe.
      map.addLayer({ id: 'fixture-route', type: 'line', source: 'fixture-route', paint: { 'line-color': '#555555', 'line-width': 2 } });
      window.glideAudit = { map, remount: () => host.mount([...modules, selection]),
        route: coordinates => {
          displayed.publish(coordinates ? [{ ...emptyRoutePlan(), approachExtensions: [coordinates] }] : []);
          map.getSource<GeoJSONSource>('fixture-route')!.setData(routeData(coordinates ?? []));
        },
        ownship: (coordinates, state = 'tracking') => position.publish({ enabled: true, state, fix: coordinates ? {
          coordinates, accuracy: 10, timestamp: Date.now(), time: performance.now() / 1000,
          altitude: null, altitudeAccuracy: null, track: null, speed: null, estimated: false,
        } : null }),
        provider: (id, enabled) => enabled ? connections[id].activate() : connections[id].deactivate(),
      };
    }); });
    return () => { alive = false; host.unmount(); for (const connection of Object.values(connections)) connection.deactivate(); map.remove(); };
  }, [plugin]);
  return <main style={{ height: '100dvh', position: 'relative', containerType: 'size' }}>
    <div ref={target} style={{ position: 'absolute', inset: 0 }} />
    <div className="map-edge-tools"><EdgePanels side="left" active={active} onActiveChange={setActive} individualTabs>
      <LayerPanels panels={plugin.panels} layout={PANEL_LAYOUT} />
    </EdgePanels></div>
    {menu && <NearbyFeaturePicker {...menu} onSelect={() => setMenu(undefined)} onClose={() => setMenu(undefined)} />}
    <output data-testid="glide-state" data-state={status.state} style={{ position: 'absolute', top: 8, right: 8 }}>{JSON.stringify(status)}</output>
    <output data-testid="errors">{errors.join('; ')}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
