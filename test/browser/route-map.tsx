import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { GeoPointFeature } from '@zlayer/contracts';
import { routeDraftFromText, routeDraftText, type RouteDraft, type RoutePlan } from '@zlayer/domain';
import { insertRouteFeature, replaceRouteFeature, removeRouteEntry } from '../../src/layers/routes/draft';
import { createRouteRemovalResolver, routeRemovalAirports as airports } from '../helpers/route-removal';
import { MapLayerHost, ROUTE_LINE_ANCHOR } from '../../src/core/map/layer';
import { createRouteLayer } from '../../src/layers/routes/layer';
import { MapGestures } from '../../src/workspace/map/gestures';
import { NearbyFeaturePicker } from '../../src/workspace/nearby-feature-picker';
import { createMetarClient } from '../../src/layers/metar-taf/metar/client';
import { FeatureDetailsPanel } from '../../src/workspace/feature-details-panel';
import type { NearbyFeature, SelectFeature } from '../../src/workspace/feature-selection';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../../src/shell/styles.css';
import '../../src/workspace/feature-details-panel.css';

setWorkerUrl(workerUrl);
const metarClient = createMetarClient();

const resolve = createRouteRemovalResolver();
const comparison = new URLSearchParams(location.search).has('comparison');
const showDetails = new URLSearchParams(location.search).has('details');
const initialRoute = new URLSearchParams(location.search).get('route') ?? 'KSBA KSMX';

function Fixture() {
  const container = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<GeoPointFeature>();
  const [selectedPointId, setSelectedPointId] = useState<string>();
  const [nearby, setNearby] = useState<{ features: NearbyFeature[]; point: { x: number; y: number } }>();
  const [edits, setEdits] = useState(0);
  const [routeText, setRouteText] = useState(initialRoute);
  const [renderedPlan, setRenderedPlan] = useState<RoutePlan>();
  const updateDraft = useRef<(change: (draft: RouteDraft) => RouteDraft) => void>(() => {});
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
    const host = new MapLayerHost(map, (_id, reason) => setError(String(reason)));
    // No navigation layers: airports remain visible through the route at this zoom.
    route.update({ route: plan, ...(comparison ? { recommendations: {
      selectedKey: 'preview', routes: [{ key: 'preview', plan }],
    } } : {}) });
    map.on('load', () => host.mount([route]));
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
      interactiveLayerIds: () => host.interactiveLayerIds(), onSelect: select,
      onChooseNearby: (features, point) => setNearby({ features, point }),
      preview: input => host.update(route, input),
      onRouteLegInsert: (afterEntryId, feature) => edit(insertRouteFeature(draft, afterEntryId, feature)),
      onRouteWaypointReplace: (entryId, feature) => edit(replaceRouteFeature(draft, entryId, feature)),
      onRouteWaypointRemove: entryId => edit(removeRouteEntry(draft, entryId)),
    });
    Object.assign(window, { routeMapAudit: { map, showNearby: (point: { x: number; y: number }) =>
      setNearby({ point, features: airports.features.map(feature => ({ feature })) }) } });
    return () => { gestures.destroy(); host.unmount(); map.remove(); };
  }, []);
  return <main style={{ position: 'absolute', inset: 0, '--touch-target': '44px' } as React.CSSProperties}>
    <div ref={container} style={{ position: 'absolute', inset: 0 }} />
    {nearby && <NearbyFeaturePicker features={nearby.features}
      point={nearby.point} onSelect={select} onClose={() => setNearby(undefined)} />}
    {showDetails && selected && renderedPlan && <FeatureDetailsPanel onIdentificationChange={() => {}} feature={selected} metarClient={metarClient}
      procedureResource={undefined} revision="test" onClose={() => select(undefined)} onOpenProcedure={() => {}}
      route={{ plan: renderedPlan, pointId: selectedPointId, update: edit => updateDraft.current(edit) }} />}
    <aside style={{ position: 'absolute', top: 0, left: 0, background: 'white', padding: 8 }}>
      <output aria-label="Selection">{selected ? `${selected.properties.kind}: ${selected.properties.name}` : 'None'}</output>
      <output aria-label="Edits">{edits}</output>
      <output aria-label="Route">{routeText}</output>
      <p role="alert">{error}</p>
    </aside>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
