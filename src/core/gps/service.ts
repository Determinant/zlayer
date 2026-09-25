import { createLayerStore } from '../layers/store';
import { GPS_MOTION_ACCURACY_METERS, GPS_MOTION_SAMPLE_MS, GPS_STALE_MS, readGpsFix, type GpsFix } from './position';

export type GpsState = 'off' | 'acquiring' | 'tracking' | 'stale' | 'denied' | 'unavailable' | 'unsupported' | 'insecure' | 'paused';
export type GpsSnapshot = { state: GpsState; fix: GpsFix | null };
const RETRY_MS = 5000;
const ACQUISITION_MS = 15_000;
const MOTION_WINDOW_MS = 2000;
type Environment = {
  geolocation: () => Pick<Geolocation, 'watchPosition' | 'clearWatch'> | undefined;
  secure: () => boolean;
  visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | undefined;
  /** Monotonic seconds, shared with device-motion events. */
  now: () => number;
};

/** One browser location watch shared by independent consumers. Construction and
 * subscriptions are passive; only acquired leases request location. */
export function createGpsService(environment: Environment = {
  geolocation: () => navigator.geolocation,
  secure: () => window.isSecureContext,
  visibility: typeof document === 'undefined' ? undefined : document,
  now: () => performance.now() / 1000,
}) {
  const store = createLayerStore<GpsSnapshot>({ state: 'off', fix: null });
  let consumers = 0;
  let generation = 0;
  let watch: { api: Pick<Geolocation, 'clearWatch'>; id: number } | undefined;
  // One deadline owns acquisition, fix expiry, or retry; no active watch can
  // wait forever for a browser callback (including its own timeout callback).
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryPending = false;
  let motionHistory: GpsFix[] = [];
  const needsLocation = () => consumers > 0;
  const publish = (change: Partial<GpsSnapshot>) => store.publish({ ...store.getSnapshot(), ...change });
  const clearTimer = () => { clearTimeout(timer); timer = undefined; retryPending = false; };
  const stop = () => {
    generation++;
    const previous = watch;
    watch = undefined;
    clearTimer();
    motionHistory = [];
    previous?.api.clearWatch(previous.id);
  };
  const schedule = (session: number, delay: number, action: () => void) => {
    clearTimer();
    timer = setTimeout(() => {
      if (session !== generation) return;
      timer = undefined; retryPending = false;
      action();
    }, delay);
  };
  const unavailable = (session: number) => {
    if (session !== generation) return;
    motionHistory = [];
    // Repeated errors/invalid callbacks cannot postpone the existing retry.
    if (!retryPending) {
      schedule(session, RETRY_MS, () => start(true));
      retryPending = true;
    }
    publish({ state: store.getSnapshot().fix ? 'stale' : 'unavailable' });
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
      schedule(session, ACQUISITION_MS, () => unavailable(session));
      const id = api.watchPosition(position => {
        if (session !== generation) return;
        const snapshot = store.getSnapshot();
        const clock = { timestamp: Date.now(), time: environment.now() };
        // Wall time and the monotonic clock can diverge during Android sleep or
        // a clock correction. Retain the last position, but not its ordering or
        // motion baseline in the new clock relationship.
        const previous = snapshot.fix;
        const clockChanged = previous !== null && Math.abs(
          clock.timestamp - clock.time * 1000 - (previous.timestamp - previous.time * 1000)) > 1000;
        if (clockChanged) {
          motionHistory = [];
          if (snapshot.state === 'tracking') publish({ state: 'stale' });
          if (session !== generation) return;
        }
        let origin = motionHistory[0] ?? null;
        for (const sample of motionHistory) {
          if (position.timestamp - sample.timestamp < MOTION_WINDOW_MS) break;
          origin = sample;
        }
        const fix = readGpsFix(position, clockChanged ? null : previous, clock, origin);
        if (!fix || (previous && (fix.timestamp === previous.timestamp || fix.time <= previous.time))) {
          if (store.getSnapshot().state !== 'tracking') unavailable(session);
          return;
        }
        // Keep a short, bounded sampling window. A fixed time baseline works at
        // high update rates and expires motion when the aircraft stops moving.
        motionHistory = motionHistory.filter(sample => (fix.time - sample.time) * 1000 <= GPS_STALE_MS);
        if ((fix.speed !== null && fix.speed < 1) || fix.accuracy > GPS_MOTION_ACCURACY_METERS) motionHistory = [];
        if (!motionHistory.length || (fix.time - motionHistory.at(-1)!.time) * 1000 >= GPS_MOTION_SAMPLE_MS) motionHistory.push(fix);
        // Stationary watches need not report periodically. Reacquire when the
        // source observation expires, preserving a clearly stale last position.
        schedule(session, Math.max(0, GPS_STALE_MS - (clock.time - fix.time) * 1000), () => start(true));
        publish({ state: 'tracking', fix });
      }, error => {
        if (session !== generation) return;
        if (error.code === 1) {
          stop();
          publish({ state: 'denied', fix: null });
        } else {
          unavailable(session);
        }
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: ACQUISITION_MS });
      if (session === generation) watch = { api, id };
      else api.clearWatch(id);
    } catch {
      if (session !== generation) return;
      stop();
      unavailable(generation);
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
