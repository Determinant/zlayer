import { createLayerStore } from '../layers/store';
import { GPS_MOTION_ACCURACY_METERS, GPS_MOTION_SAMPLE_MS, GPS_STALE_MS, readGpsFix, type GpsFix } from './position';

export type GpsState = 'off' | 'acquiring' | 'tracking' | 'stale' | 'denied' | 'unavailable' | 'unsupported' | 'insecure' | 'paused';
export type GpsSnapshot = { state: GpsState; fix: GpsFix | null };
const RETRY_MS = 5000;
const MOTION_WINDOW_MS = 2000;
type Environment = {
  geolocation: () => Pick<Geolocation, 'watchPosition' | 'clearWatch'> | undefined;
  secure: () => boolean;
  visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | undefined;
};

/** One browser location watch shared by independent consumers. Construction and
 * subscriptions are passive; only acquired leases request location. */
export function createGpsService(environment: Environment = {
  geolocation: () => navigator.geolocation,
  secure: () => window.isSecureContext,
  visibility: typeof document === 'undefined' ? undefined : document,
}) {
  const store = createLayerStore<GpsSnapshot>({ state: 'off', fix: null });
  let consumers = 0;
  let generation = 0;
  let watch: { api: Pick<Geolocation, 'clearWatch'>; id: number } | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let motionHistory: GpsFix[] = [];
  const needsLocation = () => consumers > 0;
  const publish = (change: Partial<GpsSnapshot>) => store.publish({ ...store.getSnapshot(), ...change });
  const clearExpiry = () => { clearTimeout(expiry); expiry = undefined; };
  const clearRetry = () => { clearTimeout(retry); retry = undefined; };
  const stop = () => {
    generation++;
    if (watch) watch.api.clearWatch(watch.id);
    watch = undefined;
    clearExpiry();
    clearRetry();
    motionHistory = [];
  };
  const retrySoon = (session: number) => {
    if (session !== generation || !needsLocation() || retry !== undefined) return;
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
      // Subscribers can release the last lease or replace this session.
      if (session !== generation) return;
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
        // Keep a short, bounded sampling window. A fixed time baseline works at
        // high update rates and expires motion when the aircraft stops moving.
        motionHistory = motionHistory.filter(sample => fix.timestamp - sample.timestamp <= GPS_STALE_MS);
        if ((fix.speed !== null && fix.speed < 1) || fix.accuracy > GPS_MOTION_ACCURACY_METERS) motionHistory = [];
        if (!motionHistory.length || fix.timestamp - motionHistory.at(-1)!.timestamp >= GPS_MOTION_SAMPLE_MS) motionHistory.push(fix);
        expiry = setTimeout(() => {
          // watchPosition may stay silent without a significant location change.
          // Replacing the watch explicitly requests a fresh, uncached fix.
          if (session === generation) start(true);
        }, Math.max(0, fix.timestamp + GPS_STALE_MS - Date.now()));
        publish({ state: 'tracking', fix });
      }, error => {
        if (session !== generation) return;
        clearExpiry();
        if (error.code === 1) {
          stop();
          publish({ state: 'denied', fix: null });
        } else {
          motionHistory = [];
          // Allow the current watch to recover before a bounded retry. Some
          // providers otherwise never retry after an initial acquisition error.
          publish({ state: store.getSnapshot().fix ? 'stale' : 'unavailable' });
          retrySoon(session);
        }
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
      if (session === generation) watch = { api, id };
      else api.clearWatch(id);
    } catch {
      if (session !== generation) return;
      stop();
      const recovery = generation;
      publish({ state: 'unavailable', fix: null });
      retrySoon(recovery);
    }
  };
  const visibilityChanged = () => start();
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    /** Keep location active until this consumer releases its lease. */
    acquire() {
      if (++consumers === 1) {
        environment.visibility?.addEventListener('visibilitychange', visibilityChanged);
        start();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--consumers === 0) {
          environment.visibility?.removeEventListener('visibilitychange', visibilityChanged);
          start();
        }
      };
    },
    retry: () => start(true),
  };
}

export type GpsService = ReturnType<typeof createGpsService>;
