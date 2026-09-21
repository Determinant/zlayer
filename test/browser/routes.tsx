import codedTerminal from '../fixtures/coded-terminal-procedures.json';
// Local, network-free route editor fixture. Not included in production builds.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { installRouteLayers, syncRoute } from '../../src/layers/routes/renderer';
import { installNavigationLayers, syncNavigationData } from '../../src/layers/navigation/renderer';
import { ROUTE_LINE_ANCHOR } from '../../src/core/map/layer';
import type { RoutePlan } from '@zlayer/domain';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createRoot } from 'react-dom/client';
import { isTerminalProceduresData, type CatalogResponse, type FeatureCollectionResponse, type NavigationData, type TerminalProceduresData } from '@zlayer/contracts';
import approachRoutes from '../fixtures/route-approach-legs.json';
import moffettRoutes from '../fixtures/route-approach-nuq.json';
import northBayRoutes from '../fixtures/route-approach-north-bay.json';
import { arizonaTerminal } from '../fixtures/route-approach-arizona';
import { refinementTerminal, refinementPublishedCatalog } from '../fixtures/route-approach-refinement';
import { jsonIdentity } from '../../src/core/data/json-identity';
import departures from '../fixtures/route-departures.json';
import { departureNavigation } from '../fixtures/route-departure-navigation';
import { attachRouteDepartures, createRouteResolver } from '@zlayer/domain';
import { RouteBar } from '../../src/layers/routes/bar';
import type { RouteMapPreview } from '../../src/layers/routes/map-preview';
import { createOwnshipLayer } from '../../src/layers/ownship/layer';
import { useDirectTo } from '../../src/layers/routes/use-direct-to';
import { useRouteDraft } from '../../src/layers/routes/use-draft';
import { appendRouteText, insertRouteTextBefore, moveRouteEntry, removeRouteEntry, replaceRouteText,
  routeDraftFromText, setRouteApproach, setRouteDeparture, setRouteArrival } from '../../src/layers/routes/draft';
import '../../src/styles.css';
import '@fontsource/b612/400.css';
import '@fontsource/b612/700.css';

const moffett = new URLSearchParams(location.search).has('nuq');
const sid = new URLSearchParams(location.search).has('sid');
const northBay = new URLSearchParams(location.search).get('north-bay');
const coded = new URLSearchParams(location.search).has('coded');
const arizona = new URLSearchParams(location.search).has('arizona');
const refinement = new URLSearchParams(location.search).get('refinement');
const refinedTerminal = refinement ? refinementTerminal(refinement) : undefined;
const refined = refinedTerminal?.approaches!.procedures[0];
const refinedCenter = refined?.final.find(l => l.fix?.role === 'MAP')?.fix?.coordinate;
const navigation: FeatureCollectionResponse = { type: 'FeatureCollection', features: ['KSFO', 'KSJC', 'KNUQ', 'O69', 'KAPC', 'KSTS', ...(refined ? [refined.airport] : arizona ? ['KIWA'] : [])].map((ident, i) => ({
  type: 'Feature', id: ident, geometry: { type: 'Point', coordinates: [
    [-122.375, 37.619], [-121.929, 37.362], [-122.049, 37.416], [-122.605, 38.258], [-122.281, 38.213], [-122.813, 38.509], refinedCenter ?? [-111.655, 33.307],
  ][i]! as [number, number] }, properties: { ident, ...(sid ? { faaId: ident.replace(/^K/, ''), icaoId: ident } : {}) },
})), meta: { layer: 'airports', revision: '2026-09-03', returned: arizona || refined ? 7 : 6, truncated: false } };
if (coded) {
  navigation.features.push({ type: 'Feature', id: 'KSNA', properties: { ident: 'KSNA', faaId: 'SNA', icaoId: 'KSNA' },
    geometry: { type: 'Point', coordinates: [-117.868, 33.676] } });
  navigation.meta.returned++;
}
const rawTerminal = coded ? codedTerminal : sid ? departures : refinedTerminal ?? (arizona ? arizonaTerminal(new URLSearchParams(location.search).has('missing-intercept'))
  : northBay ? northBayRoutes : moffett ? moffettRoutes : approachRoutes);
if (!isTerminalProceduresData(rawTerminal)) throw new Error('Invalid approach fixture');
const terminal: TerminalProceduresData = rawTerminal;
const publishedCatalog = refinement ? refinementPublishedCatalog(refinement, new URLSearchParams(location.search).get('plate') ?? '') : undefined;
const references: NavigationData = { airports: navigation };
if (sid) references.fixes = departureNavigation;
if (new URLSearchParams(location.search).has('navigation')) {
  const fix = terminal.approaches!.procedures.find(procedure => procedure.id === 'KSFO:I28R')!.final.find(leg => leg.fix?.ident === 'AXMUL')!.fix!;
  references.fixes = { ...navigation, meta: { ...navigation.meta, layer: 'fixes', returned: 1 }, features: [
    { type: 'Feature', id: 'fix:AXMUL', geometry: { type: 'Point', coordinates: fix.coordinate },
      properties: { kind: 'fix', ident: fix.ident, lowArtcc: 'ZOA' } },
  ] };
}
if (new URLSearchParams(location.search).has('entities')) {
  for (const [layer, points] of [
    ['fixes', [['SUNOL', 'REPORTING_POINT']]],
    ['vfr-waypoints', [['VPWAM', 'VFR']]],
    ['navaids', [['OSI', 'VOR/DME'], ['REIGA', 'NDBDME']]],
  ] as const) {
    references[layer] = { ...navigation, meta: { ...navigation.meta, layer, returned: points.length },
      features: points.map(([ident, type], index) => ({ type: 'Feature', id: `${layer}:${ident}`,
        geometry: { type: 'Point', coordinates: [-122.2 + index * .05, 37.5] }, properties: { ident, type } })) };
  }
}
const resolve = createRouteResolver(Object.values(references), undefined, terminal);
const catalog: CatalogResponse = { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-16T00:00:00Z',
  navigation: [], charts: [], weather: [], terminalProcedures: {
    id: 'terminal-procedures', title: 'Published procedure routes', url: '/route-approach-legs.json', count: terminal.procedures.length, sourceCount: terminal.procedures.length,
    ...(publishedCatalog ? { jsonSha256: jsonIdentity(terminal) } : {}),
  }, procedures: {
    id: 'procedures', title: 'Test approaches', url: '/route-approaches.json', cycle: '2609',
    ...(publishedCatalog ? { associationStatus: 'available', jsonSha256: jsonIdentity(publishedCatalog) } : {}),
    effectiveDate: '2026-09-03', expirationDate: '2026-10-01', airportCount: 1, sourceAirportCount: 1,
    procedureCount: moffett || northBay || arizona || refined ? 1 : 4, sourceProcedureCount: moffett || northBay || arizona || refined ? 1 : 4,
  } };

if (!localStorage.getItem('zlayer-route-draft-v1')) localStorage.setItem('zlayer-route-draft-v1',
  JSON.stringify({ version: 2, entries: routeDraftFromText(refined?.airport ?? (arizona ? 'KIWA' : northBay ?? (moffett ? 'KNUQ' : 'KSFO UNKNOWN KSJC'))).entries }));

function Fixture() {
  const showMap = new URLSearchParams(location.search).has('map');
  const [draft, setDraft] = useRouteDraft();
  const [preview, setPreview] = useState<RouteMapPreview>();
  const [plate, setPlate] = useState('');
  const [revision, refresh] = useState(0);
  const resolved = useMemo(() => resolve(draft), [draft, revision]);
  const normalized = useMemo(() => attachRouteDepartures(draft, resolved, terminal), [draft, resolved]);
  useEffect(() => { if (draft !== normalized) setDraft(current => current === draft ? normalized : current); }, [draft, normalized, setDraft]);
  const plan = useMemo(() => draft === normalized ? resolved : resolve(normalized), [draft, normalized, resolved]);
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
    <RouteBar plan={plan} status="ready" catalog={catalog} navigationData={references}
      onDirectTo={directTo}
      onApproachChange={(entry, approach) => setDraft(current => setRouteApproach(current, entry, approach))}
      onDepartureChange={(entry, departure) => setDraft(current => setRouteDeparture(current, entry, departure))}
      onArrivalChange={(entry, arrival) => setDraft(current => setRouteArrival(current, entry, arrival))}
      onApproachPreview={setPreview}
      onOpenPlate={selection => setPlate(selection.procedure.name)}
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
    const instance = new MapLibreMap({ container: container.current!, center: refinedCenter ?? (arizona ? [-111.65, 33.27] : northBay ? [-122.6, 38.25] : [-122.25, 37.58]), zoom: arizona ? 10 : 9,
      attributionControl: false, fadeDuration: 0, style: { version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
        layers: [{ id: 'fixture-background', type: 'background', paint: { 'background-color': '#142735' } },
          { id: ROUTE_LINE_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } }] } });
    instance.on('load', () => {
      if (references.fixes) { installNavigationLayers(instance); syncNavigationData(instance, references); }
      installRouteLayers(instance); syncRoute(instance, current.current.plan, undefined, current.current.preview); map.current = instance;
    });
    Object.assign(window, { approachMapAudit: instance });
    return () => { map.current = undefined; instance.remove(); };
  }, []);
  useEffect(() => { if (map.current) syncRoute(map.current, plan, undefined, preview); }, [plan, preview]);
  return <div className="map-canvas" aria-label="Approach map" ref={container} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
