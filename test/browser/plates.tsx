// Manual browser regression fixture, served by Vite but not included in builds.
import { lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProcedureResourceRecord } from '@zlayer/contracts';
import { emptyRoutePlan } from '@zlayer/domain';
import { fetchChartCatalog } from '../../src/workspace/catalog/catalog';
import { LayerPanels } from '../../src/core/layers/panels';
import { EdgePanels } from '../../src/core/ui/edge-panels';
import type { PanelContribution } from '../../src/core/layers/plugin';
import { PANEL_LAYOUT } from '../../src/workspace/panel-layout';
import { createPlatesLayer } from '../../src/layers/plates';
import { fetchProcedureCatalog } from '../../src/layers/plates/api';
import { procedureDocument } from '../../src/layers/plates/data';
import { createMetarClient } from '../../src/layers/metar-taf/metar/client';
import { FeatureDetailsPanel } from '../../src/workspace/feature-details-panel';
import '../../src/styles.css';

const metarClient = createMetarClient();

const plates = createPlatesLayer();
let failImport = true;
const panelFixture: PanelContribution = {
  id: 'failure-test', title: 'Test panel',
  Component: function FailingPanel() {
    const [Panel] = useState(() => lazy(async () => {
      if (failImport) throw new Error('Simulated lazy import failure');
      return { default: () => <p>Panel recovered</p> };
    }));
    return <Suspense fallback="Loading test panel…"><Panel /></Suspense>;
  },
};

function Fixture() {
  const [status, setStatus] = useState('Ready');
  const [testFailure, setTestFailure] = useState(false);
  const [offline, setOffline] = useState(false);
  const [originalFetch] = useState(() => window.fetch.bind(window));
  const [airportCard, setAirportCard] = useState<{ faaId: string; resource: ProcedureResourceRecord }>();
  const [active, setActive] = useState<string | null>(() => plates.getSnapshot().selection ? 'plate' : null);
  const open = async (kind: 'approach' | 'takeoff-minimums', fallback: boolean) => {
    try {
      setStatus('Opening plate…');
      const resource = (await fetchChartCatalog('2026-09-03')).procedures!;
      const catalog = await fetchProcedureCatalog(resource);
      const airport = catalog.airports.find(value => value.id === 'KHWD')!;
      const published = airport.procedures.find(value => value.kind === kind)!;
      const procedure = fallback ? { ...published, volumeTarget: null } : published;
      plates.open({ airport, procedure, document: procedureDocument(catalog, procedure, resource.url, location.href),
        cycle: catalog.cycle, effectiveDate: catalog.effectiveDate, expirationDate: catalog.expirationDate });
      setActive('plate');
      setStatus('Workspace remains usable');
    } catch (error) { setStatus(String(error)); }
  };
  return <main className="workspace" style={{ height: '100dvh' }}><div className="map-stage" style={{ padding: 24 }}>
    <h1>Plate viewer regression checks</h1>
    <p>{status}</p>
    <button onClick={() => void open('approach', false)}>Hosted approach</button>{' '}
    <button onClick={() => void open('approach', true)}>FAA approach fallback</button>{' '}
    <button onClick={() => void open('takeoff-minimums', true)}>FAA named fallback</button>{' '}
    {['HWD', 'SQL', '0Q3', 'ANC', 'HNL'].map(faaId => <button key={faaId} onClick={() => {
      void fetchChartCatalog('2026-09-03').then(catalog => {
        setAirportCard({ faaId, resource: catalog.procedures! }); setActive('details');
      });
    }}>Show {faaId} airport</button>)}{' '}
    <button onClick={() => {
      window.fetch = offline ? originalFetch : (input, init) => /\.pdf/i.test(String(input))
        ? Promise.reject(new TypeError('PDF network disabled by test')) : originalFetch(input, init);
      setOffline(!offline);
    }}>{offline ? 'Enable PDF network' : 'Disable PDF network'}</button>{' '}
    <button onClick={() => setTestFailure(true)}>Fail lazy panel</button>{' '}
    <button onClick={() => { failImport = false; }}>Allow panel retry</button>
    <EdgePanels side="right" active={active} onActiveChange={setActive} className="side-panels">
      {airportCard && <FeatureDetailsPanel onIdentificationChange={() => {}} key={airportCard.faaId}
        feature={{ type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
          properties: { kind: 'airport', faaId: airportCard.faaId, name: `${airportCard.faaId} fixture airport` } }}
        metarClient={metarClient} procedureResource={airportCard.resource} revision="2026-09-03"
        route={{ plan: emptyRoutePlan(), update: () => setStatus(`Added ${airportCard.faaId} to end of route`) }}
        onClose={() => { setAirportCard(undefined); setActive(current => current === 'details' ? null : current); }}
        onOpenProcedure={selection => { plates.open(selection); setActive('plate'); }} />}
      <LayerPanels panels={testFailure ? [...plates.panels, panelFixture] : plates.panels}
        layout={{ ...PANEL_LAYOUT, 'failure-test': { side: 'right', tab: { edge: 'top', order: 0 } } }} />
    </EdgePanels>
  </div></main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
