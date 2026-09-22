import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { GeoPointFeature } from '@zlayer/contracts';
import { emptyRoutePlan, routeDraftFromText, routeDraftText, type RouteDraft, type RoutePlan } from '@zlayer/domain';
import { insertRouteFeature, replaceRouteFeature, removeRouteEntry } from '../../src/layers/routes/draft';
import { createRouteRemovalResolver, routeRemovalAirports as airports } from '../helpers/route-removal';
import { MapLayerHost, ROUTE_LINE_ANCHOR } from '../../src/core/map/layer';
import { createRouteLayer } from '../../src/layers/routes/layer';
import { createWaypointInspectionLayer } from '../../src/layers/navigation/map';
import { routePointForFeature } from '../../src/layers/routes/selection';
import { MapGestures } from '../../src/workspace/map/gestures';
import { createRulerLayer, RulerTool } from '../../src/layers/ruler';
import { createRulerMapLayer } from '../../src/layers/ruler/map';
import { NearbyFeaturePicker } from '../../src/workspace/nearby-feature-picker';
import { createMetarClient } from '../../src/layers/metar-taf/metar/client';
import { FeatureDetailsPanel } from '../../src/workspace/feature-details-panel';
import { createGpsService } from '../../src/core/gps/service';
import { useDirectTo } from '../../src/layers/routes/use-direct-to';
import { DirectToDialog } from '../../src/layers/routes/direct-to-dialog';
import type { NearbyFeature, SelectFeature } from '../../src/workspace/feature-selection';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../../src/core/ui/styles.css';
import '../../src/shell/styles.css';
import '../../src/core/ui/edge-handle.css';
import '../../src/core/ui/edge-panels.css';
import '../../src/workspace/feature-details-panel.css';
import '../../src/workspace/map/styles.css';

setWorkerUrl(workerUrl);
const metarClient = createMetarClient();

const fixtureOptions = new URLSearchParams(location.search);
const missingFix = fixtureOptions.get('missingFix');
const procedureGapAfter = fixtureOptions.get('procedureGapAfter');
const resolve = createRouteRemovalResolver({ ...(missingFix ? { missingFix } : {}),
  ...(procedureGapAfter ? { procedureGapAfter } : {}) });
const comparison = new URLSearchParams(location.search).has('comparison');
const showDetails = new URLSearchParams(location.search).has('details');
const showRuler = new URLSearchParams(location.search).has('ruler');
const initialRoute = new URLSearchParams(location.search).get('route') ?? 'KSBA KSMX';
const emptyPlan = emptyRoutePlan();

function Fixture() {
  const container = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<GeoPointFeature>();
  const [selectedPointId, setSelectedPointId] = useState<string>();
  const [nearby, setNearby] = useState<{ features: NearbyFeature[]; point: { x: number; y: number } }>();
  const [edits, setEdits] = useState(0);
  const [routeText, setRouteText] = useState(initialRoute);
  const [renderedPlan, setRenderedPlan] = useState<RoutePlan>();
  const updateDraft = useRef<(change: (draft: RouteDraft) => RouteDraft) => void>(() => {});
  const [gps] = useState(createGpsService);
  const [inspection] = useState(createWaypointInspectionLayer);
  const [ruler] = useState(createRulerLayer);
  useEffect(() => inspection.update(selected?.properties.kind === 'coordinate' && renderedPlan &&
    !routePointForFeature(renderedPlan, selected) ? selected : undefined), [inspection, selected, renderedPlan]);
  const { action: directTo, confirmation } = useDirectTo(gps, renderedPlan ?? emptyPlan, edit => updateDraft.current(edit));
  useEffect(() => new URLSearchParams(location.search).has('gps') ? gps.acquire() : undefined, [gps]);
  const [error, setError] = useState('');
  const select: SelectFeature = (feature, pointId) => {
    setSelected(feature); setSelectedPointId(pointId); setNearby(undefined);
  };
  useEffect(() => {
    let draft = routeDraftFromText(initialRoute);
    let plan = resolve(draft);
    setRenderedPlan(plan);
    const map = new MapLibreMap({ container: container.current!, center: [-119, 35], zoom: 5,
      fadeDuration: 0, attributionControl: false, style: { version: 8,
        glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
        layers: [{ id: ROUTE_LINE_ANCHOR, type: 'background', paint: { 'background-color': '#314653' } }] } });
    const route = createRouteLayer();
    const rulerMap = createRulerMapLayer(ruler);
    const host = new MapLayerHost(map, (_id, reason) => setError(String(reason)));
    // No navigation layers: airports remain visible through the route at this zoom.
    route.update({ route: plan, ...(comparison ? { comparison: {
      selectedKey: 'preview', routes: [{ key: 'preview', plan }],
    } } : {}) });
    map.on('load', () => {
      if (fixtureOptions.has('snapping')) {
        map.addSource('snap-target', { type: 'geojson', data: { type: 'Feature', id: 'fix:TAILS',
          geometry: { type: 'Point', coordinates: [-119, 36] },
          properties: { kind: 'fix', ident: 'TAILS', mapFeatureId: 'fix:TAILS' } } });
        map.addLayer({ id: 'snap-target', type: 'circle', source: 'snap-target', paint: { 'circle-radius': 5 } });
        if (fixtureOptions.has('snapLabel')) map.addLayer({ id: 'snap-label', type: 'symbol', source: 'snap-target',
          layout: { 'text-field': 'TAILS NAVIGATION FIX', 'text-font': ['Noto Sans Bold'], 'text-size': 14,
            'text-anchor': 'left', 'text-offset': [1, 0], 'text-max-width': 30, 'text-allow-overlap': true } });
      }
      host.mount([route, inspection, ...(showRuler ? [rulerMap] : [])]);
    });
    map.on('error', event => setError(event.error.message));
    const edit = (next: RouteDraft) => {
      draft = next;
      plan = resolve(draft);
      host.update(route, { route: plan });
      setRouteText(routeDraftText(draft));
      setRenderedPlan(plan);
      setEdits(value => value + 1);
    };
    updateDraft.current = change => edit(change(draft));
    const gestures = new MapGestures(map, {
      route: () => plan, canEditRoute: () => !comparison,
      toolActive: () => ruler.getSnapshot().active,
      interactiveLayerIds: () => [...host.interactiveLayerIds(),
        ...['snap-target', 'snap-label'].filter(id => map.getLayer(id))], onSelect: select,
      onChooseNearby: (features, point) => setNearby({ features, point }),
      preview: input => host.update(route, input),
      onRouteLegInsert: (afterEntryId, feature) => edit(insertRouteFeature(draft, afterEntryId, feature)),
      onRouteWaypointReplace: (entryId, feature) => edit(replaceRouteFeature(draft, entryId, feature)),
      onRouteWaypointRemove: entryId => edit(removeRouteEntry(draft, entryId)),
    });
    Object.assign(window, { rulerAudit: { layer: ruler } });
    Object.assign(window, { routeMapAudit: { map, showNearby: (point: { x: number; y: number }) =>
      setNearby({ point, features: airports.features.map(feature => ({ feature })) }) } });
    return () => { gestures.destroy(); host.unmount(); map.remove(); };
  }, []);
  return <main className={showRuler ? 'map-stage' : ''} style={{ position: 'absolute', inset: 0, '--touch-target': '44px' } as React.CSSProperties}>
    <div ref={container} style={{ position: 'absolute', inset: 0 }} />
    {showRuler && <RulerTool layer={ruler} revision="2026-09-03" />}
    {nearby && <NearbyFeaturePicker features={nearby.features}
      point={nearby.point} onSelect={select} onClose={() => setNearby(undefined)} />}
    {showDetails && selected && renderedPlan && <FeatureDetailsPanel onIdentificationChange={() => {}} feature={selected} metarClient={metarClient}
      procedureResource={undefined} revision="test" onClose={() => select(undefined)} onOpenProcedure={() => {}}
      route={{ plan: renderedPlan, pointId: selectedPointId, update: edit => updateDraft.current(edit), onDirectTo: directTo }} />}
    <DirectToDialog confirmation={confirmation} />
    <aside style={{ position: 'absolute', top: 0, left: 0, background: 'white', padding: 8 }}>
      <output aria-label="Selection">{selected ? `${selected.properties.kind}: ${selected.properties.name}` : 'None'}</output>
      <output aria-label="Edits">{edits}</output>
      <output aria-label="Route">{routeText}</output>
      <p role="alert">{error}</p>
    </aside>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
