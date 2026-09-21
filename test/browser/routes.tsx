// Local, network-free route editor fixture. Not included in production builds.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { installRouteLayers, syncRoute } from '../../src/layers/routes/renderer';
import { ROUTE_LINE_ANCHOR } from '../../src/core/map/layer';
import type { RoutePlan } from '@zlayer/domain';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createRoot } from 'react-dom/client';
import { isTerminalProceduresData, type CatalogResponse, type FeatureCollectionResponse } from '@zlayer/contracts';
import approachRoutes from '../fixtures/route-approach-legs.json';
import moffettRoutes from '../fixtures/route-approach-nuq.json';
import { createRouteResolver } from '@zlayer/domain';
import { RouteBar } from '../../src/layers/routes/bar';
import type { RouteMapPreview } from '../../src/layers/routes/map-preview';
import { createOwnshipLayer } from '../../src/layers/ownship/layer';
import { useDirectTo } from '../../src/layers/routes/use-direct-to';
import { useRouteDraft } from '../../src/layers/routes/use-draft';
import { appendRouteText, insertRouteTextBefore, moveRouteEntry, removeRouteEntry, replaceRouteText,
  routeDraftFromText, setRouteApproach } from '../../src/layers/routes/draft';
import '../../src/styles.css';
import '@fontsource/b612/400.css';
import '@fontsource/b612/700.css';

const moffett = new URLSearchParams(location.search).has('nuq');
const navigation: FeatureCollectionResponse = { type: 'FeatureCollection', features: ['KSFO', 'KSJC', 'KNUQ'].map((ident, i) => ({
  type: 'Feature', id: ident, geometry: { type: 'Point', coordinates: i === 0 ? [-122.375, 37.619] : i === 1 ? [-121.929, 37.362] : [-122.049, 37.416] }, properties: { ident },
})), meta: { layer: 'airports', revision: '2026-09-03', returned: 3, truncated: false } };
const terminal = moffett ? moffettRoutes : approachRoutes;
if (!isTerminalProceduresData(terminal)) throw new Error('Invalid approach fixture');
const resolve = createRouteResolver([navigation], undefined, terminal);
const catalog: CatalogResponse = { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-16T00:00:00Z',
  navigation: [], charts: [], weather: [], terminalProcedures: {
    id: 'terminal-procedures', title: 'Published procedure routes', url: '/route-approach-legs.json', count: 0, sourceCount: 0,
  }, procedures: {
    id: 'procedures', title: 'Test approaches', url: '/route-approaches.json', cycle: '2609',
    effectiveDate: '2026-09-03', expirationDate: '2026-10-01', airportCount: 1, sourceAirportCount: 1,
    procedureCount: moffett ? 1 : 4, sourceProcedureCount: moffett ? 1 : 4,
  } };

if (!localStorage.getItem('zlayer-route-draft-v1')) localStorage.setItem('zlayer-route-draft-v1',
  JSON.stringify({ version: 2, entries: routeDraftFromText(moffett ? 'KNUQ' : 'KSFO UNKNOWN KSJC').entries }));

function Fixture() {
  const showMap = new URLSearchParams(location.search).has('map');
  const [draft, setDraft, undo] = useRouteDraft();
  const [preview, setPreview] = useState<RouteMapPreview>();
  const [plate, setPlate] = useState('');
  const [revision, refresh] = useState(0);
  const plan = useMemo(() => resolve(draft), [draft, revision]);
  const [ownship] = useState(createOwnshipLayer);
  const { action: directTo } = useDirectTo(ownship, plan, setDraft);
  useEffect(() => new URLSearchParams(location.search).has('gps') ? ownship.acquire() : undefined, [ownship]);
  useEffect(() => {
    const update = () => refresh(value => value + 1);
    window.addEventListener('route-fixture-refresh', update);
    return () => window.removeEventListener('route-fixture-refresh', update);
  }, []);
  useEffect(() => {
    if (new URLSearchParams(location.search).has('open')) {
      document.querySelector<HTMLDetailsElement>('details.route-summary')?.setAttribute('open', '');
    }
  }, []);
  return <main className="app-shell">
    <header style={{ padding: 12 }}>Route regression checks</header>
    <RouteBar plan={plan} status="ready" catalog={catalog}
      onDirectTo={directTo}
      onApproachChange={(entry, approach) => setDraft(current => setRouteApproach(current, entry, approach))}
      onApproachPreview={setPreview}
      onOpenPlate={selection => setPlate(selection.procedure.name)} undo={undo}
      onUseRoute={setDraft} onClear={() => setDraft(routeDraftFromText(''))} onFit={() => {}}
      onAppendInput={input => setDraft(current => appendRouteText(current, input))}
      onInsertInput={(index, input) => setDraft(current => insertRouteTextBefore(current, index, input))}
      onReplaceInput={(entryId, input) => setDraft(current => replaceRouteText(current, entryId, input))}
      onRemoveEntry={index => setDraft(current => removeRouteEntry(current, index))}
      onMoveEntry={(from, to) => setDraft(current => moveRouteEntry(current, from, to))} />
    {!showMap && <section style={{ padding: '120px 16px 16px' }}>
      <p>Open the warning to read the error. Clear the route and paste KSFO DCT KSJC: one direct leg should appear.</p>
      <output>{plan.legs.length} legs; {plan.issues.length} issues</output>
      {plate && <p role="status">Opened plate: {plate}</p>}
    </section>}
    {showMap && <section className="workspace"><div className="map-stage"><RouteFixtureMap plan={plan} preview={preview} /></div></section>}
  </main>;
}
function RouteFixtureMap({ plan, preview }: { plan: RoutePlan; preview: RouteMapPreview | undefined }) {
  const container = useRef<HTMLDivElement>(null), map = useRef<MapLibreMap>(undefined), current = useRef({ plan, preview });
  current.current = { plan, preview };
  useEffect(() => {
    setWorkerUrl(workerUrl);
    const instance = new MapLibreMap({ container: container.current!, center: [-122.25, 37.58], zoom: 9,
      attributionControl: false, fadeDuration: 0, style: { version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
        layers: [{ id: 'fixture-background', type: 'background', paint: { 'background-color': '#142735' } },
          { id: ROUTE_LINE_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } }] } });
    instance.on('load', () => { installRouteLayers(instance); syncRoute(instance, current.current.plan, undefined, current.current.preview); map.current = instance; });
    Object.assign(window, { approachMapAudit: instance });
    return () => { map.current = undefined; instance.remove(); };
  }, []);
  useEffect(() => { if (map.current) syncRoute(map.current, plan, undefined, preview); }, [plan, preview]);
  return <div className="map-canvas" aria-label="Approach map" ref={container} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
