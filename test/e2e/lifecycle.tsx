// Real React subscriptions/effects; included only in the browser test build.
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CatalogResponse } from '@zlayer/contracts';
import { routeDraftFromText } from '@zlayer/domain';
import { createLayerStore } from '../../src/core/layers/store';
import { useLayerSnapshot } from '../../src/core/layers/use-snapshot';
import { useOnline } from '../../src/core/use-online';
import { useInventoryVersion } from '../../src/offline/use-inventory-version';
import { notifyOfflineInventory } from '../../src/offline/inventory-events';
import { useRoutePlan } from '../../src/layers/routes/use-plan';
import { ErrorBoundary } from '../../src/core/layers/error-boundary';
import { pruneInactiveRecords, retainActiveFiles } from '../../src/offline/active-catalogs';
import { offlineRecordKeys, readOfflineRecord, writeOfflineRecord } from '../../src/core/storage/database';

const store = createLayerStore(0);
let subscribers = 0, renders = 0;
const observed = { getSnapshot: store.getSnapshot, subscribe(listener: () => void) {
  subscribers++;
  const stop = store.subscribe(listener);
  return () => { subscribers--; stop(); };
} };
const draft = routeDraftFromText('OLD NEW');
let catalog: CatalogResponse | undefined;
let root: Root | undefined;
let panelFailed = false, panelAttempt = 0;

function RecoverablePanel() {
  if (panelFailed) throw new Error('Test panel failure');
  return <input aria-label="Panel state" defaultValue="initial" />;
}

function Harness({ catalog }: { catalog: CatalogResponse | undefined }) {
  const count = useLayerSnapshot(observed);
  const online = useOnline();
  const inventory = useInventoryVersion();
  const route = useRoutePlan(catalog, draft);
  renders++;
  return <main>
    <output data-testid="count">{count}</output>
    <output data-testid="online">{String(online)}</output>
    <output data-testid="inventory">{inventory}</output>
    <output data-testid="route" data-status={route.status}>{route.plan.waypoints.map(point => point.ident).join(' ')}</output>
    <ErrorBoundary resetKey={panelAttempt} fallback={error => <p role="alert">{error.message}</p>}>
      <RecoverablePanel />
    </ErrorBoundary>
  </main>;
}

const render = () => root?.render(<StrictMode><Harness catalog={catalog} /></StrictMode>);
const lifecycle = {
  retainFiles: retainActiveFiles,
  pruneInactiveRecords,
  storage: { keys: offlineRecordKeys, read: readOfflineRecord, write: writeOfflineRecord },
  mount() { root = createRoot(document.getElementById('root')!); render(); },
  unmount() { root?.unmount(); root = undefined; },
  publish(value: number) { store.publish(value); },
  inventoryChanged: notifyOfflineInventory,
  stats: () => ({ subscribers, renders }),
  failPanel(failed: boolean) { panelFailed = failed; render(); },
  retryPanel() { panelAttempt++; render(); },
  routeExport(name: string) {
    catalog = { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-17T00:00:00Z', charts: [], weather: [],
      navigation: [{ id: 'airports', title: 'Airports', url: `/lifecycle/${name}.json`, count: 1, sourceCount: 1, minZoom: 0 }] };
    render();
  },
};
declare global { interface Window { lifecycle: typeof lifecycle } }
window.lifecycle = lifecycle;
lifecycle.mount();
