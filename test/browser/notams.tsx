import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PluginRegistry } from '../../src/core/layers/bridge';
import { createNotamsPlugin } from '../../src/layers/notams/plugin';
import { createPlatesLayer } from '../../src/layers/plates';
import type { ProcedureSelection } from '../../src/layers/plates/data';
import { FeatureDetailsPanel } from '../../src/workspace/feature-details-panel';
import { WorkspacePlateNotices, useNotamsApi } from '../../src/workspace/notams';
import type { WorkspacePluginApis } from '../../src/workspace/plugin-apis';
import type { ProcedureResourceRecord } from '@zlayer/contracts';
import { LayerPanels } from '../../src/core/layers/panels';
import { EdgePanels } from '../../src/core/ui/edge-panels';
import { PANEL_LAYOUT } from '../../src/workspace/panel-layout';
import { createMetarClient } from '../../src/layers/metar-taf/metar/client';
import { emptyRoutePlan } from '@zlayer/domain';
import '@fontsource/b612/400.css';
import '@fontsource/b612/700.css';
import '../../src/styles.css';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MapLayerHost } from '../../src/core/map/layer';
import { createLayerInput } from '../../src/core/layers/store';
import type { MapSelectionInput, MapContextAction, NearbyFeature } from '../../src/core/map/selection';
import { createSelectionContribution } from '../../src/workspace/map/selection';
import { NearbyFeaturePicker } from '../../src/workspace/nearby-feature-picker';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { installObstructions, syncObstructions } from '../../src/layers/obstructions/renderer';
import 'maplibre-gl/dist/maplibre-gl.css';

const registry = new PluginRegistry<WorkspacePluginApis>(), product = createNotamsPlugin();
const plates = createPlatesLayer(props => <WorkspacePlateNotices {...props} registry={registry} />);
const registration = registry.registration('notams', product);
const metarClient = createMetarClient();
const resource = (window as unknown as { notamFixtureResource: ProcedureResourceRecord }).notamFixtureResource;
const savedSelection = (window as unknown as { notamFixtureSelection: ProcedureSelection }).notamFixtureSelection;
const airport = { faaId: 'TST', icaoId: 'KTST' };
function MapFixture({ enabled }: { enabled: boolean }) {
  const target = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ features: NearbyFeature[]; point: { x: number; y: number }; actions: MapContextAction[] }>();
  const live = useRef<{ map?: MapLibreMap; host?: MapLayerHost; reconcile?: () => void; enabled: boolean }>({ enabled });
  useEffect(() => {
    const state = live.current; state.enabled = enabled;
    state.reconcile?.();
  }, [enabled]);
  useEffect(() => {
    let disposed = false;
    const state = live.current;
    void import('maplibre-gl').then(({ Map, setWorkerUrl }) => {
      if (disposed) return;
      setWorkerUrl(workerUrl);
      const map = new Map({ container: target.current!, center: [-122.012, 37.004], zoom: 13,
        attributionControl: false, fadeDuration: 0, canvasContextAttributes: { preserveDrawingBuffer: true },
        style: { version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
          layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#132333' } }] } });
      state.map = map;
      Object.assign(window, { notamMapAudit: { map } });
      const host = state.host = new MapLayerHost(map, (_id, error) => { throw error; });
      const input = createLayerInput<MapSelectionInput>();
      input.set({ resolveFeature: feature => feature, onSelect: () => setMenu(undefined),
        onChooseNearby: (features, point, actions = []) => setMenu({ features, point, actions }), onCloseNearby: () => setMenu(undefined) });
      const selection = createSelectionContribution(input, scope => registry.forScope(scope), {
        map, signal: new AbortController().signal, preserveView: true, interactiveLayerIds: () => host.interactiveLayerIds(),
        occupiedRects: () => [], targetBearing: () => 0, run: (_id, action) => action(), reportError: error => { throw error; },
      });
      map.on('load', () => {
        // A permanent DOF symbol beside the temporary preview verifies ownership/color separation.
        installObstructions(map);
        syncObstructions(map, { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'dof-reference',
          geometry: { type: 'Point', coordinates: [-122.024, 37.004] }, properties: { oas: 'dof-reference',
            icon: 'obstruction-low-single-plain', label: 'DOF reference\n700 (550)', routeOpacity: 1,
            elevationMslFt: 700, heightAglFt: 550, minZoom: 0 } }] });
        void product.mapContribution.load().then(modules => {
          if (disposed) return;
          state.reconcile = () => host.reconcile([selection, ...(state.enabled ? modules : [])]);
          state.reconcile();
        });
      });
    });
    return () => { disposed = true; state.host?.unmount(); state.map?.remove(); };
  }, []);
  return <><div ref={target} style={{ position: 'absolute', inset: 0 }} />
    {menu && <NearbyFeaturePicker {...menu} onClose={() => setMenu(undefined)} onSelect={() => setMenu(undefined)} />}
    <button style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 20 }} onClick={() => {
      const state = live.current; state.host?.reconcile([]); state.reconcile?.();
    }}>Remount NOTAM map</button></>;
}
function Fixture() {
  const [active, setActive] = useState<string | null>('details'), [withPlates, setWithPlates] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [chartEnabled, setChartEnabled] = useState(true);
  const api = useNotamsApi(registry);
  useEffect(() => { if (enabled) registration.activate(); else registration.deactivate(); return () => registration.deactivate(); }, [enabled]);
  return <main className="workspace" style={{ height: '100dvh' }}><div className="map-stage">
    {new URLSearchParams(location.search).has('map') && <MapFixture enabled={enabled && chartEnabled} />}
    <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 20, maxWidth: 220 }}>
      <button onClick={() => setEnabled(value => !value)}>{enabled ? 'Disable NOTAM plugin' : 'Enable NOTAM plugin'}</button>
      <button onClick={() => setWithPlates(value => !value)}>Toggle Plates availability</button>
      <button onClick={() => setActive(value => value ? null : 'details')}>Stow fixture</button>
      <button onClick={() => { plates.open(savedSelection); setActive('plate'); }}>Open saved plate</button>
      {new URLSearchParams(location.search).has('map') && <button onClick={() => setChartEnabled(value => !value)}>{chartEnabled ? 'Detach NOTAM chart' : 'Attach NOTAM chart'}</button>}
    </div>
    <EdgePanels side="right" active={active} onActiveChange={setActive} className="side-panels">
      <FeatureDetailsPanel key={airport.faaId} feature={{ type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
        properties: { kind: 'airport', ...airport, name: 'Invented fixture airport' } }} revision="2026-10-01" metarClient={metarClient}
        notamsApi={api} onIdentificationChange={() => {}}
        procedureResource={resource} savedSupplement={{ url: 'https://example.test/unused.json' }}
        features={{ routes: false, weather: false, terrain: false, plates: withPlates }}
        route={{ plan: emptyRoutePlan(), navigationData: {}, update() {}, onIdentify() {}, onIdentificationPreview() {} }}
        onClose={() => setActive(null)} onOpenProcedure={selection => { plates.open(selection); setActive('plate'); }} />
      <LayerPanels panels={plates.panels} layout={PANEL_LAYOUT} />
      {enabled && <LayerPanels panels={product.panels} layout={PANEL_LAYOUT} />}
    </EdgePanels>
  </div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
