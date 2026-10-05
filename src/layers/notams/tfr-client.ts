import { isTfrSnapshot, TFR_DETAIL_REFRESH_MS, TFR_MAX_BYTES, TFR_REFRESH_MS, type TfrSnapshot } from '@zlayer/contracts';
import { requestJson } from '../../core/data/request-json';
import { createLayerStore } from '../../core/layers/store';
import { OnDemandRefresh } from '../../core/layers/on-demand-refresh';
import { tfrSnapshot } from './storage';
import { tfrTiming } from './tfr-time';

export type TfrState = { snapshot?: TfrSnapshot; now: number; loading: boolean; error?: string };
export function createTfrClient(dependencies: { now?: () => number; load?: (signal: AbortSignal) => Promise<TfrSnapshot>;
  storage?: Pick<typeof tfrSnapshot, 'read' | 'write'>; debounceMs?: number } = {}) {
  const now = dependencies.now ?? Date.now, storage = dependencies.storage ?? tfrSnapshot;
  const state = createLayerStore<TfrState>({ now: now(), loading: false });
  const load = dependencies.load ?? ((signal: AbortSignal) => requestJson('/api/notams/tfrs', isTfrSnapshot, 'TFRs', { signal, maxBytes: TFR_MAX_BYTES }));
  let refresh: OnDemandRefresh | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const validTime = (snapshot: TfrSnapshot) => snapshot.checkedAt <= now() + 30_000 &&
    snapshot.notices.every(n => n.detailCheckedAt === undefined || n.detailCheckedAt <= now() + 30_000);
  function clock() {
    clearTimeout(timer);
    if (!refresh) return;
    const time = now(); state.publish({ ...state.getSnapshot(), now: time });
    const boundaries = state.getSnapshot().snapshot?.notices.flatMap(n => [
      ...n.areas.map(a => tfrTiming(n,a,time)?.boundary ?? Infinity),
      ...(n.detailCheckedAt !== undefined && n.detailCheckedAt + TFR_DETAIL_REFRESH_MS > time ? [n.detailCheckedAt + TFR_DETAIL_REFRESH_MS] : []),
    ]) ?? [];
    const delay = boundaries.reduce((delay, t) => Math.min(delay, Math.max(1,t-time)), 30_000);
    timer = setTimeout(clock, delay);
  }
  function demand() { refresh?.setDemand(['national'], typeof navigator === 'undefined' || navigator.onLine !== false); }
  function start() {
    if (refresh) return;
    try {
      const saved = storage.read();
      if (saved && isTfrSnapshot(saved) && validTime(saved) &&
        saved.checkedAt >= (state.getSnapshot().snapshot?.checkedAt ?? 0)) state.publish({ snapshot: saved, now: now(), loading: false });
    } catch { /* Optional offline restoration. */ }
    refresh = new OnDemandRefresh({ intervalMs: TFR_REFRESH_MS, debounceMs: dependencies.debounceMs ?? 100,
      onState(loading) { state.publish({ ...state.getSnapshot(), loading }); },
      onError() { state.publish({ ...state.getSnapshot(), error: 'Unable to refresh TFRs' }); },
      async refresh(_ids, signal) {
        const snapshot = await load(signal); signal.throwIfAborted();
        if (!isTfrSnapshot(snapshot) || !validTime(snapshot) ||
          snapshot.checkedAt < (state.getSnapshot().snapshot?.checkedAt ?? 0)) throw new Error('Invalid TFR snapshot');
        state.publish({ snapshot, now: now(), loading: false });
        try { storage.write(snapshot); } catch { /* Online display survives storage failure. */ }
        clock();
      } });
    if (typeof window !== 'undefined') { window.addEventListener('online', demand); window.addEventListener('offline', demand); }
    demand(); clock();
  }
  function stop() {
    refresh?.destroy(); refresh = undefined; clearTimeout(timer); timer = undefined;
    if (typeof window !== 'undefined') { window.removeEventListener('online', demand); window.removeEventListener('offline', demand); }
    state.publish({ ...state.getSnapshot(), loading: false });
  }
  return { state, start, stop };
}
