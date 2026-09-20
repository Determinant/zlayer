import { createLayerStore } from '../../core/layers/store';
import { estimateTurnRate, GPS_MOTION_ACCURACY_METERS, GPS_MOTION_SAMPLE_MS, GPS_STALE_MS, readGpsFix, type GpsFix } from './position';

export type OwnshipState = 'off' | 'acquiring' | 'tracking' | 'stale' | 'denied' | 'unavailable' | 'unsupported' | 'insecure' | 'paused';
export type OwnshipSnapshot = {
  enabled: boolean; state: OwnshipState; fix: GpsFix | null; centerRequest: number;
  /** Recent GPS ground-track turn rate in degrees per second, clockwise positive. */
  turnRate: number | null;
};
const RETRY_MS = 5000;
const MOTION_WINDOW_MS = 2000;
type Environment = {
  geolocation: () => Pick<Geolocation, 'watchPosition' | 'clearWatch'> | undefined;
  secure: () => boolean;
  visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | undefined;
};

/** One shared position watch for map and tool consumers; no history is persisted. */
export function createOwnshipLayer(environment: Environment = {
  geolocation: () => navigator.geolocation,
  secure: () => window.isSecureContext,
  visibility: typeof document === 'undefined' ? undefined : document,
}) {
  const store = createLayerStore<OwnshipSnapshot>({ enabled: false, state: 'off', fix: null, centerRequest: 0, turnRate: null });
  let attached = false;
  let consumers = 0;
  let listening = false;
  let demanded = false;
  let generation = 0;
  let watch: { api: Pick<Geolocation, 'clearWatch'>; id: number } | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let motionHistory: GpsFix[] = [];
  let turnHistoryStart = -Infinity;
  let centerOnFix = true;
  const needsLocation = () => consumers > 0 || (attached && store.getSnapshot().enabled);
  const publish = (change: Partial<OwnshipSnapshot>) => {
    const next = { ...store.getSnapshot(), ...change };
    if (next.state !== 'tracking') next.turnRate = null;
    store.publish(next);
  };
  const clearExpiry = () => { clearTimeout(expiry); expiry = undefined; };
  const clearRetry = () => { clearTimeout(retry); retry = undefined; };
  const stop = () => {
    generation++;
    if (watch) watch.api.clearWatch(watch.id);
    watch = undefined;
    clearExpiry();
    clearRetry();
    motionHistory = [];
    turnHistoryStart = -Infinity;
  };
  const retrySoon = (session: number) => {
    if (retry !== undefined) return;
    retry = setTimeout(() => { if (session === generation) start(true); }, RETRY_MS);
  };
  const start = (retainFix = false) => {
    stop();
    if (!needsLocation()) { publish({ state: 'off', fix: null }); return; }
    if (environment.visibility?.hidden) { publish({ state: 'paused', fix: null }); return; }
    if (!environment.secure()) { publish({ state: 'insecure', fix: null }); return; }
    const session = generation;
    try {
      const api = environment.geolocation();
      if (!api) { publish({ state: 'unsupported', fix: null }); return; }
      const fix = retainFix ? store.getSnapshot().fix : null;
      publish({ state: fix ? 'stale' : 'acquiring', fix });
      const id = api.watchPosition(position => {
        if (session !== generation) return;
        const snapshot = store.getSnapshot();
        let origin = motionHistory[0] ?? null;
        for (const sample of motionHistory) {
          if (position.timestamp - sample.timestamp < MOTION_WINDOW_MS) break;
          origin = sample;
        }
        const fix = readGpsFix(position, snapshot.fix, Date.now(), origin);
        if (!fix) {
          if (snapshot.state !== 'tracking') {
            publish({ state: snapshot.fix ? 'stale' : 'unavailable' });
            retrySoon(session);
          }
          return;
        }
        clearExpiry();
        clearRetry();
        // Remember continuity boundaries even between retained motion samples.
        if (fix.track === null || fix.speed === null || (snapshot.fix && fix.estimated !== snapshot.fix.estimated)) {
          turnHistoryStart = fix.timestamp;
        }
        const turnRate = estimateTurnRate(fix, motionHistory.filter(sample => sample.timestamp >= turnHistoryStart));
        // Keep a short, bounded sampling window. A fixed time baseline works at
        // high update rates and expires motion when the aircraft stops moving.
        motionHistory = motionHistory.filter(sample => fix.timestamp - sample.timestamp <= GPS_STALE_MS);
        if ((fix.speed !== null && fix.speed < 1) || fix.accuracy > GPS_MOTION_ACCURACY_METERS) motionHistory = [];
        if (!motionHistory.length || fix.timestamp - motionHistory.at(-1)!.timestamp >= GPS_MOTION_SAMPLE_MS) motionHistory.push(fix);
        const centerRequest = snapshot.centerRequest + (snapshot.enabled && centerOnFix ? 1 : 0);
        if (snapshot.enabled) centerOnFix = false;
        expiry = setTimeout(() => {
          // watchPosition may stay silent without a significant location change.
          // Replacing the watch explicitly requests a fresh, uncached fix.
          if (session === generation) start(true);
        }, Math.max(0, fix.timestamp + GPS_STALE_MS - Date.now()));
        publish({ state: 'tracking', fix, centerRequest, turnRate });
      }, error => {
        if (session !== generation) return;
        clearExpiry();
        if (error.code === 1) {
          stop();
          publish({ state: 'denied', fix: null });
        } else {
          motionHistory = [];
          turnHistoryStart = -Infinity;
          // Allow the current watch to recover before a bounded retry. Some
          // providers otherwise never retry after an initial acquisition error.
          publish({ state: store.getSnapshot().fix ? 'stale' : 'unavailable' });
          retrySoon(session);
        }
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
      if (session === generation) watch = { api, id };
      else api.clearWatch(id);
    } catch {
      stop();
      publish({ state: 'unavailable', fix: null });
      retrySoon(generation);
    }
  };
  const visibilityChanged = () => start();
  const syncDemand = () => {
    const listen = attached || consumers > 0;
    if (listen !== listening) {
      if (listen) environment.visibility?.addEventListener('visibilitychange', visibilityChanged);
      else environment.visibility?.removeEventListener('visibilitychange', visibilityChanged);
      listening = listen;
    }
    const next = needsLocation();
    if (next === demanded) return;
    demanded = next;
    start();
  };
  return {
    definition: { id: 'ownship', title: 'GPS aircraft' },
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    setEnabled(enabled: boolean) {
      if (enabled === store.getSnapshot().enabled) return;
      centerOnFix = true;
      publish({ enabled });
      syncDemand();
    },
    attach() {
      if (attached) return;
      attached = true;
      syncDemand();
    },
    detach() {
      attached = false;
      syncDemand();
    },
    /** Share the existing location watch without enabling the map aircraft. */
    acquire() {
      consumers++;
      syncDemand();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        consumers--;
        syncDemand();
      };
    },
    retry: () => start(true),
    center() {
      if (store.getSnapshot().state === 'tracking') publish({ centerRequest: store.getSnapshot().centerRequest + 1 });
    },
  };
}

export type OwnshipLayer = ReturnType<typeof createOwnshipLayer>;
