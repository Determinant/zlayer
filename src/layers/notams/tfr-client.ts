import { isTfrSnapshot, TFR_MAX_BYTES, TFR_REFRESH_MS, type TfrSnapshot } from '@zlayer/contracts';
import { requestJson } from '../../core/data/request-json';
import { createLayerStore } from '../../core/layers/store';
import { OnDemandRefresh } from '../../core/layers/on-demand-refresh';
import { tfrSnapshot } from './storage';
import { tfrNextChange } from './tfr-time';

export type TfrState = { snapshot?: TfrSnapshot; now: number; loading: boolean; error?: string };
export function createTfrClient(dependencies: { now?: () => number; load?: (signal: AbortSignal) => Promise<TfrSnapshot>;
  storage?: Pick<typeof tfrSnapshot, 'read' | 'update'>; debounceMs?: number } = {}) {
  const now = dependencies.now ?? Date.now, storage = dependencies.storage ?? tfrSnapshot;
  const state = createLayerStore<TfrState>({ now: now(), loading: false });
  const load = dependencies.load ?? ((signal: AbortSignal) => requestJson('/api/notams/tfrs', isTfrSnapshot, 'TFRs', { signal, maxBytes: TFR_MAX_BYTES }));
  let refresh: OnDemandRefresh | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const validTime = (snapshot: TfrSnapshot) => snapshot.checkedAt <= now() + 30_000 &&
    snapshot.notices.every(n => n.detailCheckedAt === undefined || n.detailCheckedAt <= now() + 30_000);
  const canReplace = (snapshot: TfrSnapshot, previous: TfrSnapshot | null | undefined) =>
    !previous || !validTime(previous) || snapshot.checkedAt >= previous.checkedAt;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  function clock() {
    clearTimeout(timer); timer = undefined;
    if (!refresh || !visible()) return;
    const time = now(); state.publish({ ...state.getSnapshot(), now: time });
    const delay = Math.min(30_000, Math.max(1, tfrNextChange(state.getSnapshot().snapshot, time) - time));
    timer = setTimeout(clock, delay);
  }
  function demand() {
    refresh?.setDemand(['national'], visible() && (typeof navigator === 'undefined' || navigator.onLine !== false));
    clock();
  }
  function start() {
    if (refresh) return;
    try {
      const saved = storage.read();
      if (saved && isTfrSnapshot(saved) && validTime(saved) &&
        canReplace(saved, state.getSnapshot().snapshot)) state.publish({ snapshot: saved, now: now(), loading: false });
    } catch { /* Optional offline restoration. */ }
    refresh = new OnDemandRefresh({ intervalMs: TFR_REFRESH_MS, debounceMs: dependencies.debounceMs ?? 100,
      onState(loading) { state.publish({ ...state.getSnapshot(), loading }); },
      onError() { state.publish({ ...state.getSnapshot(), error: 'Unable to refresh TFRs' }); },
      async refresh(_ids, signal) {
        const snapshot = await load(signal); signal.throwIfAborted();
        if (!isTfrSnapshot(snapshot) || !validTime(snapshot) ||
          !canReplace(snapshot, state.getSnapshot().snapshot)) throw new Error('Invalid TFR snapshot');
        state.publish({ snapshot, now: now(), loading: false });
        clock();
        try { await storage.update(saved => validTime(snapshot) && canReplace(snapshot, saved) ? snapshot : saved, signal); }
        catch { /* Online display survives storage failure. */ }
      } });
    if (typeof window !== 'undefined') { window.addEventListener('online', demand); window.addEventListener('offline', demand); }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', demand);
    demand();
  }
  function stop() {
    refresh?.destroy(); refresh = undefined; clearTimeout(timer); timer = undefined;
    if (typeof window !== 'undefined') { window.removeEventListener('online', demand); window.removeEventListener('offline', demand); }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', demand);
    state.publish({ ...state.getSnapshot(), loading: false });
  }
  return { state, start, stop };
}
