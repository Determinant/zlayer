import { awcGridProduct, type AwcGridMode, type AwcGridProduct } from '@zlayer/contracts';
import { OnDemandRefresh } from '../../../core/layers/on-demand-refresh';
import { withAbort } from '../../../core/data/abort';
import { GridClient, type GridProductState } from './client';
import { gridKey, type DecodedGrid } from './format';
import type { ForecastManifest } from './native-source';
import { framesAt, gridScope, planPreparation, type GridInput, type PlannedFrame, type GridPreparation } from './planning';
import { GridReceipts, GRID_RETRY_MS } from './receipts';

export type GridState = {
  products: Record<AwcGridProduct, GridProductState>;
  data?: DecodedGrid | undefined; loading: boolean; error?: string | undefined;
  nearby?: readonly DecodedGrid[] | undefined;
  preparation?: GridPreparation | undefined;
};
const REQUEST_MS = 60_000;
export function gridTimes(state: GridState, mode: AwcGridMode, altitude: number): number[] {
  const product = awcGridProduct(mode), manifest = product && state.products[product].manifest;
  return manifest ? [...new Set(framesAt(manifest, altitude).map(frame => frame.validTime))] : [];
}
async function request<T>(task: AbortController, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = setTimeout(() => task.abort(new Error('Forecast loading timed out')), REQUEST_MS);
  try { return await withAbort(work(task.signal), task.signal); }
  finally { clearTimeout(timeout); }
}

/** One selected read and bounded background saves. Core owns downloads and files.
 * Live catalogs advance on validation; offline pointers wait for a saved file. */
export function createGridController(client: GridClient, changed: (state: GridState) => void,
  families: readonly AwcGridProduct[] = ['clouds', 'icing']) {
  let state: GridState = { products: { clouds: { loading: false }, icing: { loading: false }, winds: { loading: false },
    ...Object.fromEntries(families.map(product => [product, client.restore(product)])) }, loading: false };
  const incoming = new Map<AwcGridProduct, GridProductState>();
  const savedCatalogs = new Map<AwcGridProduct, ForecastManifest>();
  for (const product of families) {
    const manifest = state.products[product].manifest;
    if (manifest) savedCatalogs.set(product, manifest);
  }
  const progress = new Map<AwcGridProduct, GridReceipts>();
  const saves = new Map<string, AbortController>();
  let input: GridInput | undefined, scheduler: OnDemandRefresh | undefined;
  let selected: { key: string; online: boolean; task: AbortController } | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined, stopMemory: (() => void) | undefined;
  let stopFiles: (() => void) | undefined, inventoryTask: AbortController | undefined;
  let inventoryTimer: ReturnType<typeof setTimeout> | undefined, inventoryDirty = true, inventoryCheckedAt = 0;
  let updating = false, rerun = false;
  const publish = (patch: Partial<GridState>) => {
    if (Object.entries(patch).every(([key, value]) => state[key as keyof GridState] === value)) return;
    state = { ...state, ...patch }; changed(state);
  };
  const productState = (product: AwcGridProduct, record: GridProductState) => publish({ products: { ...state.products, [product]: record } });
  const cancelSelected = () => { selected?.task.abort(); selected = undefined; };
  const cancelSaves = () => { for (const task of saves.values()) task.abort(); saves.clear(); };
  const adopt = (manifest: ForecastManifest) => {
    const next = incoming.get(manifest.product);
    if (next?.manifest !== manifest) return;
    incoming.delete(manifest.product);
    productState(manifest.product, next);
  };
  const persistCatalog = (manifest: ForecastManifest, receipts: GridReceipts) => {
    const record = state.products[manifest.product];
    if (record.manifest !== manifest || savedCatalogs.get(manifest.product) === manifest || record.storageError ||
      ![...receipts.frames.values()].some(receipt => receipt.saved)) return;
    // Display readiness does not prove persistence. Keep the previous offline
    // catalog until this catalog has at least one successful file receipt.
    const saved = client.remember(manifest);
    if (saved) savedCatalogs.set(manifest.product, manifest);
    else productState(manifest.product, { ...record, storageError: 'Forecasts could not be saved for reopening offline.' });
  };
  const progressFor = (product: AwcGridProduct, horizon: readonly PlannedFrame[]) => {
    let record = progress.get(product);
    if (!record) { record = new GridReceipts(); progress.set(product, record); }
    record.retain(horizon.map(item => item.key), Date.now());
    return record;
  };
  const scheduleInventory = () => {
    inventoryDirty = true;
    const product = input && awcGridProduct(input.mode);
    if (!scheduler || !input?.enabled || !input.visible || !product || !families.includes(product) || inventoryTask || inventoryTimer) return;
    // Batch publication hints; never resave in response to an eviction. Marking
    // missing receipts false stops distant work until explicit retry/repair.
    inventoryTimer = setTimeout(() => {
      inventoryTimer = undefined;
      const demand = input, product = demand && awcGridProduct(demand.mode);
      const manifest = product && (incoming.get(product) ?? state.products[product]).manifest;
      if (!demand || !product || !manifest || !families.includes(product)) return;
      const { horizon } = gridScope(manifest, demand, Date.now()), receipts = progressFor(product, horizon);
      const items = horizon.filter(item => receipts.frames.get(item.key)?.saved !== undefined);
      const before = items.map(item => receipts.frames.get(item.key)!);
      const task = inventoryTask = new AbortController(); inventoryDirty = false;
      void request(task, signal => client.checkSaved(manifest, items.map(item => item.frame), signal)).then(saved => {
        if (inventoryTask !== task || task.signal.aborted || inventoryDirty || progress.get(product) !== receipts) return;
        receipts.reconcileInventory(items.map((item, i) => ({ key: item.key, receipt: before[i]!, saved: saved[i]! })));
      }).catch(() => { /* A later publication, resume or periodic check can retry. */ }).finally(() => {
        if (inventoryTask !== task) return;
        inventoryTask = undefined; inventoryCheckedAt = Date.now();
        if (inventoryDirty) scheduleInventory();
        reconcile();
      });
    }, 250);
  };
  const show = (manifest: ForecastManifest, data: DecodedGrid, receipts: GridReceipts, saving = false) => {
    const key = gridKey(manifest, data.frame), saved = client.saved(data);
    receipts.loaded(key, saved, saving); adopt(manifest);
    publish({ data, loading: false, error: undefined });
  };
  const select = (manifest: ForecastManifest, frame: PlannedFrame | undefined, receipts: GridReceipts, online: boolean) => {
    if (!frame) { cancelSelected(); publish({ data: undefined, loading: false, error: undefined }); return; }
    if (state.data && gridKey(state.data.manifest, state.data.frame) === frame.key) {
      // Update source metadata without discarding bytes or their save receipt.
      const data = client.peek(manifest, frame.frame) ?? state.data;
      if (state.data !== data) publish({ data });
      if (client.saved(data)) receipts.saved(frame.key, true);
      adopt(manifest); return;
    }
    if (selected?.key === frame.key && selected.online === online) return;
    cancelSelected();
    const cached = client.peek(manifest, frame.frame);
    if (cached) { show(manifest, cached, receipts); return; }
    const failure = receipts.frames.get(frame.key)?.error;
    if (failure) { publish({ data: undefined, loading: false, error: failure.message }); return; }
    const task = new AbortController(); selected = { key: frame.key, online, task };
    publish({ data: undefined, loading: true, error: undefined });
    const loading = request(task, signal => client.load(manifest, frame.frame, signal, online, data => {
      if (selected?.task === task && !task.signal.aborted) { show(manifest, data, receipts, true); reconcile(); }
    }));
    // A selected read joins an existing core acquisition before its speculative
    // consumer releases it. Other background work yields to that selection.
    cancelSaves();
    void loading.then(data => {
      if (selected?.task === task) show(manifest, data, receipts);
    }, error => {
      if (selected?.task !== task) return;
      const message = error instanceof Error ? error.message : 'Forecast unavailable';
      const displayed = !!state.data && gridKey(state.data.manifest, state.data.frame) === frame.key;
      receipts.failed(frame.key, message, Date.now(), displayed);
      if (!displayed) publish({ data: undefined, error: message });
      publish({ loading: false });
    }).finally(() => { if (selected?.task === task) { selected = undefined; reconcile(); } });
  };
  const prepare = (manifest: ForecastManifest, starts: readonly PlannedFrame[], receipts: GridReceipts, demand: GridInput, hasSelection: boolean) => {
    for (const item of starts) {
      if (input !== demand || !scheduler) break;
      const task = new AbortController(); saves.set(item.key, task);
      void request(task, signal => client.prepare(manifest, item.frame, signal, demand.online)).then(saved => {
        if (saves.get(item.key) !== task) return;
        receipts.saved(item.key, saved);
        if (!hasSelection) adopt(manifest);
      }, error => {
        if (saves.get(item.key) === task) receipts.failed(item.key, error instanceof Error ? error.message : 'Forecast preparation failed', Date.now());
      }).finally(() => { if (saves.get(item.key) === task) { saves.delete(item.key); reconcile(); } });
    }
  };
  const update = () => {
    clearTimeout(retryTimer); retryTimer = undefined;
    const demand = input, product = demand && awcGridProduct(demand.mode);
    const active = !!scheduler && !!demand?.enabled && demand.visible && !!product && families.includes(product);
    scheduler?.setDemand(active && demand.online ? [product] : [], active && demand.online);
    for (const family of families) if (!active || family !== product) client.neighborhood(family);
    if (!active) {
      clearTimeout(inventoryTimer); inventoryTimer = undefined; inventoryTask?.abort(); inventoryTask = undefined; inventoryDirty = true;
      cancelSelected(); cancelSaves();
      publish({ data: undefined, nearby: undefined, loading: false, error: undefined, preparation: undefined }); return;
    }
    const record = demand.online ? incoming.get(product) ?? state.products[product] : state.products[product];
    const manifest = record.manifest;
    if (!manifest) {
      cancelSelected(); cancelSaves();
      publish({ data: undefined, nearby: undefined, loading: record.loading, error: record.error,
        preparation: record.loading ? { ready: 0, total: 0, failed: 0 } : undefined }); return;
    }
    const scope = gridScope(manifest, demand, Date.now()), receipts = progressFor(product, scope.horizon);
    client.neighborhood(product, manifest, scope.nearby.map(item => item.frame));
    const wanted = new Set(scope.saves.map(item => item.key));
    for (const [key, task] of saves) if (!wanted.has(key)) { task.abort(); saves.delete(key); }
    select(manifest, scope.selected, receipts, demand.online);
    if (input !== demand || !scheduler) return;
    persistCatalog(manifest, receipts);
    const current = state.products[product];
    const nearby = scope.nearby.flatMap(item => client.peek(manifest, item.frame) ?? []);
    if (nearby.length !== state.nearby?.length || nearby.some((data, index) => data !== state.nearby?.[index])) publish({ nearby });
    if (input !== demand || !scheduler) return;
    const work = planPreparation(scope, demand, receipts.frames, {
      selectedPending: !!selected, dataReady: !!state.data, catalogSaved: savedCatalogs.get(product) === manifest,
      storageError: current.manifest === manifest && !!current.storageError, saving: new Set(saves.keys()),
      warm: new Set(scope.horizon.filter(item => client.wants(manifest, item.frame) && !client.peek(manifest, item.frame)).map(item => item.key)),
    });
    prepare(manifest, work.starts, receipts, demand, !!scope.selected);
    if (input !== demand || !scheduler) return;
    if (JSON.stringify(work.preparation) !== JSON.stringify(state.preparation)) publish({ preparation: work.preparation });
    if (Number.isFinite(work.retryAt)) retryTimer = setTimeout(reconcile, Math.max(1, Math.min(GRID_RETRY_MS, work.retryAt - Date.now())));
    if (inventoryDirty || Date.now() < inventoryCheckedAt || Date.now() - inventoryCheckedAt >= GRID_RETRY_MS) scheduleInventory();
  };
  function reconcile() {
    // Store and decoded-memory publications can synchronously configure us again.
    // Finish the current effects, then plan against the newest input and receipts.
    if (updating) { rerun = true; return; }
    updating = true;
    try { do { rerun = false; update(); } while (rerun); } finally { updating = false; }
  }
  const finishChecks = () => {
    for (const product of families) if (state.products[product].loading) productState(product, { ...state.products[product], loading: false });
  };
  return {
    getSnapshot: () => state,
    configure(next: GridInput) {
      if (input && (Object.keys({ ...input, ...next }) as (keyof GridInput)[]).every(key => input![key] === next[key])) {
        // The parent's clock still ticks while a past hour is selected. Browser
        // eviction may be silent even though the forecast inputs did not change.
        if (Date.now() < inventoryCheckedAt || Date.now() - inventoryCheckedAt >= GRID_RETRY_MS) scheduleInventory();
        return;
      }
      if (input?.online !== next.online) { cancelSelected(); cancelSaves(); for (const record of progress.values()) record.clearErrors(); }
      if (input?.online !== next.online || input?.visible !== next.visible || input?.mode !== next.mode || input?.altitude !== next.altitude) inventoryDirty = true;
      input = next; if (scheduler) reconcile();
    },
    retry() {
      for (const record of progress.values()) record.retry();
      for (const product of families) {
        const { storageError, ...record } = state.products[product];
        if (storageError) productState(product, record);
      }
      scheduler?.setDemand([], false); reconcile();
    },
    attach() {
      stopMemory = client.subscribeMemory(reconcile);
      stopFiles = client.subscribeFiles(scheduleInventory);
      scheduler = new OnDemandRefresh({ intervalMs: 5 * 60_000, retryIntervalMs: 30_000, debounceMs: 0, onError() {}, onState(loading) { if (!loading) finishChecks(); },
        async refresh(ids, signal) {
          const failures: unknown[] = [];
          for (const product of ids as AwcGridProduct[]) {
            productState(product, { ...state.products[product], loading: true }); reconcile();
            try {
              const manifest = await client.refresh(product, signal); signal.throwIfAborted();
              incoming.set(product, { manifest, checkedAt: Date.now(), loading: false });
              progress.get(product)?.clearErrors();
              const { error: _old, ...current } = state.products[product];
              productState(product, { ...current, loading: false });
              if (!current.manifest) adopt(manifest);
            } catch (error) {
              if (signal.aborted) return;
              failures.push(error);
              productState(product, { ...state.products[product], loading: false, error: error instanceof Error ? error.message : 'Forecast refresh failed' });
            }
            reconcile();
          }
          if (failures.length) throw new AggregateError(failures, 'Forecast refresh failed');
        } });
      reconcile();
    },
    detach() {
      stopMemory?.(); stopMemory = undefined;
      stopFiles?.(); stopFiles = undefined;
      clearTimeout(inventoryTimer); inventoryTimer = undefined; inventoryTask?.abort(); inventoryTask = undefined; inventoryDirty = true;
      clearTimeout(retryTimer); retryTimer = undefined;
      scheduler?.destroy(); scheduler = undefined; cancelSelected(); cancelSaves(); incoming.clear(); progress.clear();
      for (const family of families) client.neighborhood(family);
      finishChecks(); publish({ data: undefined, nearby: undefined, loading: false, error: undefined, preparation: undefined });
    },
  };
}
