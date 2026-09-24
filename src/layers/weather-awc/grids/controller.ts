import { awcGridProduct, type AwcGridMode, type AwcGridProduct } from '@zlayer/contracts';
import { OnDemandRefresh } from '../../../core/layers/on-demand-refresh';
import { withAbort } from '../../../core/data/abort';
import { currentFrame } from '../time';
import { GridClient, type GridProductState } from './client';
import { gridKey, type DecodedGrid } from './format';
import type { ForecastFrame, ForecastManifest } from './native-source';
import { windFrames } from './wind-levels';

export type GridState = {
  products: Record<AwcGridProduct, GridProductState>;
  data?: DecodedGrid | undefined; loading: boolean; error?: string | undefined;
  nearby?: readonly DecodedGrid[] | undefined;
  preparation?: { ready: number; total: number; failed: number; limited?: boolean; error?: string } | undefined;
};
type Input = { enabled: boolean; mode: AwcGridMode; altitude: number; time: number; online: boolean; visible: boolean;
  concurrency?: number; prepareTimeline?: boolean; pausePreparation?: boolean };
type Frame = { frame: ForecastFrame; key: string };
type Progress = { saved: Map<string, boolean>; errors: Map<string, { at: number; message: string }> };
const RETRY_MS = 60_000, REQUEST_MS = 60_000;
const framesAt = (manifest: ForecastManifest, altitude: number): ForecastFrame[] => manifest.product === 'winds'
  ? windFrames(manifest, altitude) : manifest.frames.filter(frame => manifest.product !== 'icing' || frame.altitudeFtMsl === altitude);
export function gridTimes(state: GridState, mode: AwcGridMode, altitude: number): number[] {
  const product = awcGridProduct(mode), manifest = product && state.products[product].manifest;
  return manifest ? [...new Set(framesAt(manifest, altitude).map(frame => frame.validTime))] : [];
}
function plan(manifest: ForecastManifest, input: Input) {
  const frames = framesAt(manifest, input.altitude), times = frames.map(frame => frame.validTime);
  const now = Date.now(), current = currentFrame(times, now, manifest.cadenceMs) ?? now;
  const selectedTime = currentFrame(times, input.time, manifest.cadenceMs);
  const horizon = frames.filter(frame => frame.validTime >= current || frame.validTime === selectedTime)
    .sort((a, b) => a.validTime - b.validTime).map(frame => ({ frame, key: gridKey(manifest, frame) }));
  const selected = horizon.find(item => item.frame.validTime === selectedTime);
  const index = horizon.findIndex(item => item.frame.validTime === (selectedTime ?? current));
  const nearby = index < 0 ? [] : [horizon[index], horizon[index + 1], horizon[index - 1]].filter((item): item is Frame => !!item);
  return { selected, horizon, nearby, saves: input.online && input.prepareTimeline !== false ? horizon : nearby };
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
  const progress = new Map<AwcGridProduct, Progress>();
  const saves = new Map<string, AbortController>();
  let input: Input | undefined, scheduler: OnDemandRefresh | undefined;
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
  const persistCatalog = (manifest: ForecastManifest, receipts: Progress) => {
    const record = state.products[manifest.product];
    if (record.manifest !== manifest || savedCatalogs.get(manifest.product) === manifest || record.storageError ||
      ![...receipts.saved.values()].some(saved => saved)) return;
    // Display readiness does not prove persistence. Keep the previous offline
    // catalog until this catalog has at least one successful file receipt.
    const saved = client.remember(manifest);
    if (saved) savedCatalogs.set(manifest.product, manifest);
    else productState(manifest.product, { ...record, storageError: 'Forecasts could not be saved for reopening offline.' });
  };
  const progressFor = (product: AwcGridProduct, horizon: readonly Frame[]) => {
    let record = progress.get(product);
    if (!record) { record = { saved: new Map(), errors: new Map() }; progress.set(product, record); }
    const keys = new Set(horizon.map(item => item.key)), now = Date.now();
    for (const key of record.saved.keys()) if (!keys.has(key)) record.saved.delete(key);
    for (const [key, error] of record.errors) if (!keys.has(key) || now < error.at || now - error.at >= RETRY_MS) record.errors.delete(key);
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
      const { horizon } = plan(manifest, demand), receipts = progressFor(product, horizon);
      const items = horizon.filter(item => receipts.saved.has(item.key));
      const before = items.map(item => receipts.saved.get(item.key));
      const task = inventoryTask = new AbortController(); inventoryDirty = false;
      void request(task, signal => client.checkSaved(manifest, items.map(item => item.frame), signal)).then(saved => {
        if (inventoryTask !== task || task.signal.aborted || inventoryDirty || progress.get(product) !== receipts) return;
        items.forEach((item, i) => {
          if (receipts.saved.get(item.key) === before[i]) receipts.saved.set(item.key, saved[i]!);
        });
      }).catch(() => { /* A later publication, resume or periodic check can retry. */ }).finally(() => {
        if (inventoryTask !== task) return;
        inventoryTask = undefined; inventoryCheckedAt = Date.now();
        if (inventoryDirty) scheduleInventory();
        reconcile();
      });
    }, 250);
  };
  const show = (manifest: ForecastManifest, data: DecodedGrid, receipts: Progress, saving = false) => {
    const key = gridKey(manifest, data.frame), saved = client.saved(data);
    if (saved || !saving) receipts.saved.set(key, saved);
    receipts.errors.delete(key); adopt(manifest);
    publish({ data, loading: false, error: undefined });
  };
  const select = (manifest: ForecastManifest, frame: Frame | undefined, receipts: Progress, online: boolean) => {
    if (!frame) { cancelSelected(); publish({ data: undefined, loading: false, error: undefined }); return; }
    if (state.data && gridKey(state.data.manifest, state.data.frame) === frame.key) {
      // Update source metadata without discarding bytes or their save receipt.
      const data = client.peek(manifest, frame.frame) ?? state.data;
      if (state.data !== data) publish({ data });
      if (client.saved(data)) receipts.saved.set(frame.key, true);
      adopt(manifest); return;
    }
    if (selected?.key === frame.key && selected.online === online) return;
    cancelSelected();
    const cached = client.peek(manifest, frame.frame);
    if (cached) { show(manifest, cached, receipts); return; }
    if (receipts.errors.has(frame.key)) { publish({ data: undefined, loading: false, error: receipts.errors.get(frame.key)!.message }); return; }
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
      receipts.errors.set(frame.key, { at: Date.now(), message });
      if (state.data && gridKey(state.data.manifest, state.data.frame) === frame.key) receipts.saved.set(frame.key, false);
      else { receipts.saved.delete(frame.key); publish({ data: undefined, error: message }); }
      publish({ loading: false });
    }).finally(() => { if (selected?.task === task) { selected = undefined; reconcile(); } });
  };
  const prepare = (manifest: ForecastManifest, scope: ReturnType<typeof plan>, receipts: Progress, demand: Input, canSave: boolean) => {
    // Resource-lock hashing is asynchronous. Let the selected frame become
    // usable before a speculative file can take the single decoder/save slot.
    const capacity = demand.pausePreparation || selected && (!state.data || !demand.online) ? 0
      : Math.max(0, (demand.concurrency ?? 2) - Number(!!selected) - saves.size);
    if (!capacity) return;
    // Until the catalog is saved, only acquire/retry nearby files. Their first
    // successful receipt unlocks the catalog and then the rest of the horizon.
    const work = savedCatalogs.get(manifest.product) === manifest ? scope.saves : scope.nearby;
    const queue = work.filter(item => !saves.has(item.key) && !receipts.errors.has(item.key) &&
      (item.key !== scope.selected?.key || !!state.data && !selected))
      .map(item => ({ ...item, warm: client.wants(manifest, item.frame) && !client.peek(manifest, item.frame) }))
      .filter(item => item.warm || demand.online && canSave && receipts.saved.get(item.key) !== true)
      .sort((a, b) => Number(b.warm) - Number(a.warm) || Math.abs(a.frame.validTime - demand.time) - Math.abs(b.frame.validTime - demand.time) || b.frame.validTime - a.frame.validTime);
    for (const item of queue.slice(0, capacity)) {
      const task = new AbortController(); saves.set(item.key, task);
      void request(task, signal => client.prepare(manifest, item.frame, signal, demand.online)).then(saved => {
        if (saves.get(item.key) !== task) return;
        receipts.saved.set(item.key, saved);
        if (!scope.selected) adopt(manifest);
      }, error => {
        if (saves.get(item.key) === task) receipts.errors.set(item.key, { at: Date.now(), message: error instanceof Error ? error.message : 'Forecast preparation failed' });
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
    const scope = plan(manifest, demand), receipts = progressFor(product, scope.horizon);
    client.neighborhood(product, manifest, scope.nearby.map(item => item.frame));
    const wanted = new Set(scope.saves.map(item => item.key));
    for (const [key, task] of saves) if (!wanted.has(key)) { task.abort(); saves.delete(key); }
    select(manifest, scope.selected, receipts, demand.online);
    if (input !== demand) return;
    persistCatalog(manifest, receipts);
    const current = state.products[product], metadataSaved = savedCatalogs.get(product) === manifest;
    const limited = scope.saves.some(item => receipts.saved.get(item.key) === false) || current.manifest === manifest && !!current.storageError;
    const nearby = scope.nearby.flatMap(item => client.peek(manifest, item.frame) ?? []);
    if (nearby.length !== state.nearby?.length || nearby.some((data, index) => data !== state.nearby?.[index])) publish({ nearby });
    prepare(manifest, scope, receipts, demand, !limited);
    const errors = scope.saves.flatMap(item => receipts.errors.get(item.key) ?? []);
    const preparation = !demand.online || !scope.saves.length ? undefined : {
      ready: metadataSaved ? scope.saves.filter(item => receipts.saved.get(item.key) === true).length : 0,
      total: scope.saves.length, failed: errors.length, ...(limited ? { limited: true } : {}), ...(errors.length ? { error: errors[0]!.message } : {}) };
    if (JSON.stringify(preparation) !== JSON.stringify(state.preparation)) publish({ preparation });
    const retry = Math.min(...errors.map(error => error.at + RETRY_MS));
    if (Number.isFinite(retry)) retryTimer = setTimeout(reconcile, Math.max(1, Math.min(RETRY_MS, retry - Date.now())));
    if (inventoryDirty || Date.now() < inventoryCheckedAt || Date.now() - inventoryCheckedAt >= RETRY_MS) scheduleInventory();
  };
  function reconcile() {
    if (updating) { rerun = true; return; }
    updating = true;
    try { do { rerun = false; update(); } while (rerun); } finally { updating = false; }
  }
  const finishChecks = () => {
    for (const product of families) if (state.products[product].loading) productState(product, { ...state.products[product], loading: false });
  };
  return {
    getSnapshot: () => state,
    configure(next: Input) {
      if (input && (Object.keys({ ...input, ...next }) as (keyof Input)[]).every(key => input![key] === next[key])) {
        // The parent's clock still ticks while a past hour is selected. Browser
        // eviction may be silent even though the forecast inputs did not change.
        if (Date.now() < inventoryCheckedAt || Date.now() - inventoryCheckedAt >= RETRY_MS) scheduleInventory();
        return;
      }
      if (input?.online !== next.online) { cancelSelected(); cancelSaves(); for (const record of progress.values()) record.errors.clear(); }
      if (input?.online !== next.online || input?.visible !== next.visible || input?.mode !== next.mode || input?.altitude !== next.altitude) inventoryDirty = true;
      input = next; if (scheduler) reconcile();
    },
    retry() {
      for (const record of progress.values()) { record.errors.clear(); for (const [key, saved] of record.saved) if (!saved) record.saved.delete(key); }
      for (const product of families) {
        const { storageError, ...record } = state.products[product];
        if (storageError) productState(product, record);
      }
      scheduler?.setDemand([], false); reconcile();
    },
    attach() {
      stopMemory = client.subscribeMemory(reconcile);
      stopFiles = client.subscribeFiles(scheduleInventory);
      scheduler = new OnDemandRefresh({ intervalMs: 5 * 60_000, debounceMs: 0, onError() {}, onState(loading) { if (!loading) finishChecks(); },
        async refresh(ids, signal) {
          for (const product of ids as AwcGridProduct[]) {
            productState(product, { ...state.products[product], loading: true }); reconcile();
            try {
              const manifest = await client.refresh(product, signal); signal.throwIfAborted();
              incoming.set(product, { manifest, checkedAt: Date.now(), loading: false });
              progress.get(product)?.errors.clear();
              scheduler!.options.intervalMs = 5 * 60_000;
              const { error: _old, ...current } = state.products[product];
              productState(product, { ...current, loading: false });
              if (!current.manifest) adopt(manifest);
            } catch (error) {
              if (signal.aborted) return;
              scheduler!.options.intervalMs = 30_000;
              productState(product, { ...state.products[product], loading: false, error: error instanceof Error ? error.message : 'Forecast refresh failed' });
            }
            reconcile();
          }
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
