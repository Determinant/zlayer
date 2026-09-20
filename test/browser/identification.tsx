import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { GeoPointFeature } from '@zlayer/contracts';
import { emptyRoutePlan, nearbyVorStations } from '@zlayer/domain';
import { MapLayerHost } from '../../src/core/map/layer';
import { createNavaidIdentificationLayer } from '../../src/layers/navigation/identification-layer';
import { createMetarClient } from '../../src/layers/metar-taf/metar/client';
import { FeatureDetailsPanel } from '../../src/workspace/feature-details-panel';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../../src/styles.css';

setWorkerUrl(workerUrl);
const metarClient = createMetarClient();

const parameters = new URLSearchParams(location.search);
const hasAlignment = !parameters.has('missing-alignment');
const clustered = parameters.has('clustered');
const duplicateNames = parameters.has('duplicate-names');
const point: GeoPointFeature = { type: 'Feature', properties: { kind: 'coordinate', ident: '350000N1190000W' },
  geometry: { type: 'Point', coordinates: [-119, 35] } };
const stations = nearbyVorStations(point.geometry.coordinates, (clustered ? [
  // Published 2026-09-03 positions reproduce short, nearly parallel references.
  ['GMN', -118.86136027, 34.80402861, 16], ['EHF', -119.09729363, 35.48455436, 14],
  ['LHS', -118.57693805, 34.68297333, 15],
] : [
  ['CMA', -119.4, 34.6, 15], ['RZS', -119.8, 35.3, 15], ['GVO', -118.5, 35.4, 15],
  ['TEST', -118.8, 35.1, 15], ['NEAR', -119, 35.01, 15], ['FAR', -119, 36.4, 15],
]).map(([ident, longitude, latitude, variation], index): GeoPointFeature => ({
  type: 'Feature', ...(duplicateNames ? {} : { id: String(ident) }),
  properties: { kind: 'navaid', ident: duplicateNames ? 'DUP' : String(ident), type: 'VOR/DME', state: 'CA',
    frequency: duplicateNames ? `${112 + index}.0` : '115.8', ...(hasAlignment ? { stationDeclinationDeg: Number(variation) } : {}) },
  geometry: { type: 'Point', coordinates: [Number(longitude), Number(latitude)] },
})));

function Fixture() {
  const container = useRef<HTMLDivElement>(null);
  const [layer] = useState(createNavaidIdentificationLayer);
  const [open, setOpen] = useState(false);
  const [references, setReferences] = useState(stations);
  const [selected, setSelected] = useState<GeoPointFeature | undefined>(point);
  const [error, setError] = useState('');
  const plan = useMemo(emptyRoutePlan, []);
  useEffect(() => {
    const map = new MapLibreMap({ container: container.current!, center: [-118.7, 35], zoom: 7,
      fadeDuration: 0, attributionControl: false, style: { version: 8,
        glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8e1c9' } }] } });
    const host = new MapLayerHost(map, (_id, reason) => setError(String(reason)));
    map.on('load', () => host.mount([layer]));
    map.on('error', event => setError(event.error.message));
    Object.assign(window, { identificationAudit: { map } });
    return () => { host.unmount(); map.remove(); };
  }, [layer]);
  useEffect(() => layer.update(open && selected ? { point: selected, stations: references } : undefined), [layer, open, selected, references]);
  return <main style={{ position: 'absolute', inset: 0, '--touch-target': '44px' } as React.CSSProperties}>
    <div ref={container} style={{ position: 'absolute', inset: 0 }} />
    {selected && <FeatureDetailsPanel feature={selected} metarClient={metarClient} procedureResource={undefined}
      revision="test" route={{ plan, update() {} }} onOpenProcedure={() => {}}
      onClose={() => { setOpen(false); setSelected(undefined); }}
      identification={open ? { stations: references, loading: false } : undefined} onIdentificationChange={setOpen} />}
    {duplicateNames && <button style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 50 }}
      onClick={() => setReferences(current => [...current].reverse())}>Reverse stations</button>}
    <p role="alert" style={{ position: 'absolute', top: 0, left: 0 }}>{error}</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
