import { isNotamQuery, isNotamRegionQuery, isNotamSnapshot, notamQueryKey, NOTAM_AIRPORT_MAX_BYTES, NOTAM_REFRESH_MS,
  type NotamQuery, type NotamSnapshot } from '@zlayer/contracts';
import { requestJson } from '../../core/data/request-json';
import { createLayerStore } from '../../core/layers/store';
import { OnDemandRefresh } from '../../core/layers/on-demand-refresh';
import { airportSnapshots, querySnapshots, MAX_QUERY_SNAPSHOTS, mergeNotamSnapshots, notamSnapshotTimeValid } from './storage';
import type { NotamQueryState, NotamsApi, NotamsState } from './public';

export function createNotamsClient(dependencies: {
  now?: () => number;
  load?: (query: NotamQuery, signal: AbortSignal) => Promise<NotamSnapshot>;
  storage?: Pick<typeof querySnapshots, 'read' | 'update'>;
  debounceMs?: number;
} = {}) {
  const now = dependencies.now ?? Date.now, storage = dependencies.storage ?? querySnapshots;
  const state = createLayerStore<NotamsState>({ queries: {}, now: now() });
  const consumers = new Map<symbol, { query: NotamQuery; online: boolean }>();
  const attempts = new Map<string, number>();
  const sizes = new Map<string, number>();
  let refresh: OnDemandRefresh | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let epoch = 0;
  const load = dependencies.load ?? ((query, signal) => requestJson(
    `/api/notams/${isNotamRegionQuery(query) ? 'regions' : 'navaidId' in query ? 'navaids' : 'airports'}?${new URLSearchParams(query)}`,
    isNotamSnapshot, 'NOTAMs', { signal, maxBytes: NOTAM_AIRPORT_MAX_BYTES }));
  const validTime = (snapshot: NotamSnapshot) => notamSnapshotTimeValid(snapshot, now());
  function update(key: string, value: NotamQueryState) {
    const queries = { ...state.getSnapshot().queries, [key]: value };
    if (value.snapshot !== state.getSnapshot().queries[key]?.snapshot) sizes.set(key, value.snapshot ? JSON.stringify(value.snapshot).length * 2 : 0);
    const demanded = new Set([...consumers.values()].map(v => notamQueryKey(v.query)));
    const unused = Object.keys(queries).filter(k => !demanded.has(k)).sort((a, b) => (queries[b]?.retrievedAt ?? 0) - (queries[a]?.retrievedAt ?? 0));
    let total = [...sizes.values()].reduce((sum, size) => sum + size, 0), count = Object.keys(queries).length;
    for (const key of unused.reverse()) {
      if (count <= MAX_QUERY_SNAPSHOTS && total <= 64 * 1024 * 1024) break;
      delete queries[key]; count--; total -= sizes.get(key) ?? 0; sizes.delete(key); attempts.delete(key);
    }
    state.publish({ queries, now: now() });
  }
  async function persist(snapshot: NotamSnapshot, signal: AbortSignal) {
    try { await storage.update(saved => mergeNotamSnapshots(saved, snapshot, now()), signal); }
    catch { /* Online results do not depend on optional storage. */ }
  }
  function demand() {
    refresh?.setDemand([...consumers.values()].filter(v => v.online).map(v => notamQueryKey(v.query)), true);
    if (consumers.size && !timer) {
      state.publish({ ...state.getSnapshot(), now: now() });
      timer = setInterval(() => state.publish({ ...state.getSnapshot(), now: now() }), 30_000);
    }
    if (!consumers.size) { clearInterval(timer); timer = undefined; }
  }
  const retain: NotamsApi['retain'] = (query, online) => {
    if (!isNotamQuery(query) || !refresh) return () => {};
    const token = Symbol(); consumers.set(token, { query, online }); demand();
    return () => { consumers.delete(token); demand(); };
  };
  function start() {
    if (refresh) return;
    const activation = ++epoch;
    try {
      // Prefer the current record on equal checks and when restoration reaches the memory cap.
      for (const snapshot of [...storage.read(), ...(!dependencies.storage ? airportSnapshots.read() : [])]) {
        if (!isNotamSnapshot(snapshot) || !validTime(snapshot)) continue;
        const key = notamQueryKey(snapshot.query), old = state.getSnapshot().queries[key];
        if (!old?.snapshot || !validTime(old.snapshot) || (old.snapshot.feed.checkedAt ?? 0) < (snapshot.feed.checkedAt ?? 0)) update(key, { snapshot, loading: false });
      }
    } catch { /* Optional restoration. */ }
    refresh = new OnDemandRefresh({ intervalMs: NOTAM_REFRESH_MS, debounceMs: dependencies.debounceMs ?? 0,
      onState() {}, onError() {}, async refresh(keys, signal) {
        const saves: Promise<void>[] = [];
        for (const key of keys) {
          signal.throwIfAborted();
          const query = [...consumers.values()].find(v => v.online && notamQueryKey(v.query) === key)?.query;
          if (!query) continue;
          const old = state.getSnapshot().queries[key], last = attempts.get(key);
          if (last !== undefined && now() >= last && now() - last < NOTAM_REFRESH_MS && !old?.error) continue;
          const requestedAt = now();
          update(key, { ...old, loading: true });
          try {
            const snapshot = await load(query, signal); signal.throwIfAborted();
            if (!isNotamSnapshot(snapshot) || notamQueryKey(snapshot.query) !== key || !validTime(snapshot)) throw new Error('Invalid NOTAM snapshot');
            // Clock rollback can make previously accepted data implausibly future-dated.
            if (old?.snapshot?.feed.environment === snapshot.feed.environment && validTime(old.snapshot) &&
              (old.snapshot.feed.checkedAt ?? 0) > (snapshot.feed.checkedAt ?? 0)) throw new Error('NOTAM snapshot regressed');
            // Cancelled reads never throttle a replacement activation.
            attempts.set(key, requestedAt);
            update(key, { snapshot, loading: false, retrievedAt: now() });
            saves.push(persist(snapshot, signal));
          } catch {
            if (signal.aborted) {
              if (activation === epoch) { attempts.delete(key); update(key, { ...old, loading: false }); }
              signal.throwIfAborted();
            }
            attempts.set(key, requestedAt);
            update(key, { ...old, loading: false, error: 'Unable to refresh NOTAMs. Saved results may be out of date.' });
          }
        }
        // Keep saves within the cancellable round without delaying other query reads.
        await Promise.all(saves);
        // A skipped fresh query keeps its original deadline when demand changes.
        const time = now();
        return Math.min(NOTAM_REFRESH_MS, ...keys.map(key => {
          const last = attempts.get(key);
          return last === undefined || time < last ? 0 : Math.max(0, last + NOTAM_REFRESH_MS - time);
        }));
      } });
    demand();
  }
  function stop() {
    epoch++;
    refresh?.destroy(); refresh = undefined; consumers.clear(); clearInterval(timer); timer = undefined;
    state.publish({ ...state.getSnapshot(), queries: Object.fromEntries(Object.entries(state.getSnapshot().queries)
      .map(([key, entry]) => [key, { ...entry, loading: false }])) });
  }
  function retry() { attempts.clear(); refresh?.setDemand([], false); demand(); }
  return { state, retain, start, stop, retry };
}
