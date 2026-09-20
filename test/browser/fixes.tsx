// Real MapLibre placement fixture: /test/browser/fixes.html on the Vite server.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { AirwayDataResponse, FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import { emptyRoutePlan } from '@zlayer/domain';
import { MapGestures } from '../../src/workspace/map/gestures';
import { createNavigationLayer } from '../../src/layers/navigation/layer';
import { INTERACTIVE_LAYER_IDS } from '../../src/layers/navigation/renderer';
import { DEFAULT_VISIBILITY } from '../../src/layers/navigation/definitions';
import { DEFAULT_FIX_DISPLAY } from '../../src/layers/navigation/fix-display';
import { FixDisplayControls } from '../../src/layers/navigation/fix-display-controls';
import '../../src/styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);
const specs: Array<[string, string[], number]> = [
  ['JOIN', ['ENROUTE LOW'], -122.02], ['AIRWY', ['ENROUTE LOW'], -122.01],
  ['OFFRT', ['ENROUTE LOW'], -122], ['ARRIV', ['STAR'], -121.99], ['APPRO', ['IAP'], -121.98],
];
const features: GeoPointFeature[] = specs.map(([ident, charts, longitude]) => ({
  type: 'Feature', id: `fix:${ident}`, geometry: { type: 'Point', coordinates: [longitude, 37] },
  properties: { kind: 'fix', ident, charts, state: 'CA', country: 'US',
    useCode: ['AIRWY', 'APPRO'].includes(ident) ? 'WP' : 'RP',
    ...(ident === 'OFFRT' ? { chartingRemark: 'RNAV' } : {}),
  },
}));
const fixes: FeatureCollectionResponse = { type: 'FeatureCollection', features,
  meta: { layer: 'fixes', revision: 'test', returned: features.length, truncated: false } };
const visualWaypoints: FeatureCollectionResponse = { type: 'FeatureCollection',
  features: ['VPONE', 'VPTWO'].map((ident, index) => ({ type: 'Feature', id: `fix:${ident}`,
    geometry: { type: 'Point', coordinates: [-122 + index * 0.0015, 37.008] },
    properties: { kind: 'vfr-waypoint', ident, useCode: 'VFR' },
  })), meta: { layer: 'vfr-waypoints', revision: 'test', returned: 2, truncated: false },
};
const airways: AirwayDataResponse = { type: 'ZLayerAirways', metadata: { effectiveDate: 'test', source: 'fixture' },
  airways: [['V1', 'JOIN', 'AIRWY'], ['T2', 'JOIN']].map(([ident, ...points]) => ({
    id: ident!, ident: ident!, points, segments: points.map((from, sequence) => ({ from, sequence, gap: false, fromType: 'RP', state: 'CA', country: 'US' })),
  })) };

function Fixture() {
  const container = useRef<HTMLDivElement>(null);
  const [product] = useState(createNavigationLayer);
  const [settings, setSettings] = useState(DEFAULT_FIX_DISPLAY);
  const [visible, setVisible] = useState(true);
  const [visualVisible, setVisualVisible] = useState(true);
  const [selected, setSelected] = useState<GeoPointFeature>();
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(10);
  const map = useRef<MapLibreMap>(null);
  useEffect(() => {
    const target = new MapLibreMap({ container: container.current!, center: [-122, 37], zoom: 10,
      fadeDuration: 0, attributionControl: false, style: { version: 8,
        glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#314653' } }] } });
    map.current = target;
    target.on('zoom', () => setZoom(target.getZoom()));
    target.on('error', event => setError(event.error.message));
    target.on('load', () => { product.mount(target); });
    const gestures = new MapGestures(target, {
      route: () => emptyRoutePlan(''),
      canEditRoute: () => false,
      interactiveLayerIds: () => INTERACTIVE_LAYER_IDS.filter(id => target.getLayer(id)),
      onSelect: setSelected,
      preview: () => {}, onRouteLegInsert: () => {}, onRouteWaypointReplace: () => {}, onRouteWaypointRemove: () => {},
    });
    Object.assign(window, { fixAudit: {
      map: target,
      names: () => target.queryRenderedFeatures({ layers: ['fixes-icons', 'fixes-priority-icons'] })
        .map(feature => feature.properties.ident),
      visualNames: () => target.queryRenderedFeatures({ layers: ['vfr-waypoints-icons'] })
        .map(feature => feature.properties.ident),
    } });
    return () => { gestures.destroy(); product.unmount(); target.remove(); };
  }, [product]);
  useEffect(() => { product.update({ data: { fixes, 'vfr-waypoints': visualWaypoints }, airways, fixDisplay: settings,
    visibility: { ...DEFAULT_VISIBILITY, fixes: visible, 'vfr-waypoints': visualVisible }, priorityFixes: selected ? [selected] : [] });
  }, [settings, visible, visualVisible, selected, product]);
  return <main style={{ display: 'grid', gridTemplateColumns: '320px 1fr', height: '100vh' }}>
    <aside style={{ padding: 16 }}>
      <FixDisplayControls value={settings} onChange={setSettings} />
      <p><label>Zoom <input aria-label="Zoom" type="number" value={zoom} min={3} max={22} step={0.1}
        onChange={event => map.current?.jumpTo({ zoom: Number(event.target.value) })} /></label></p>
      <div className="segmented-list">
        <button onClick={() => setSelected(selected ? undefined : features[4])}>{selected ? 'Clear selection' : 'Select APPRO'}</button>
        <button onClick={() => setVisible(!visible)}>{visible ? 'Hide background fixes' : 'Show background fixes'}</button>
        <button onClick={() => setVisualVisible(!visualVisible)}>{visualVisible ? 'Hide VFR waypoints' : 'Show VFR waypoints'}</button>
      </div>
      <p role="alert">{error}</p>
    </aside>
    <div ref={container} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
