import { useEffect, useState } from 'react';
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
import '../../src/styles.css';

const registry = new PluginRegistry<WorkspacePluginApis>(), product = createNotamsPlugin();
const plates = createPlatesLayer(props => <WorkspacePlateNotices {...props} registry={registry} />);
const registration = registry.registration('notams', product);
const metarClient = createMetarClient();
const resource = (window as unknown as { notamFixtureResource: ProcedureResourceRecord }).notamFixtureResource;
const savedSelection = (window as unknown as { notamFixtureSelection: ProcedureSelection }).notamFixtureSelection;
const airport = { faaId: 'TST', icaoId: 'KTST' };
function Fixture() {
  const [active, setActive] = useState<string | null>('details'), [withPlates, setWithPlates] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const api = useNotamsApi(registry);
  useEffect(() => { if (enabled) registration.activate(); else registration.deactivate(); return () => registration.deactivate(); }, [enabled]);
  return <main className="workspace" style={{ height: '100dvh' }}><div className="map-stage">
    <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 20, maxWidth: 220 }}>
      <button onClick={() => setEnabled(value => !value)}>{enabled ? 'Disable NOTAM plugin' : 'Enable NOTAM plugin'}</button>
      <button onClick={() => setWithPlates(value => !value)}>Toggle Plates availability</button>
      <button onClick={() => setActive(value => value ? null : 'details')}>Stow fixture</button>
      <button onClick={() => { plates.open(savedSelection); setActive('plate'); }}>Open saved plate</button>
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
    </EdgePanels>
  </div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
