import { createLayerStore } from '../../core/layers/store';
import type { GpsService, GpsState } from '../../core/gps/service';
import { GPS_MOTION_ACCURACY_METERS, GPS_MOTION_SAMPLE_MS, GPS_STALE_MS, type GpsFix } from '../../core/gps/position';
import { estimateTurnRate, MOTION_TIME_EPSILON_SECONDS, smoothMotion, type DisplayMotion } from './position';

export type OwnshipState = GpsState;
export type OwnshipSnapshot = DisplayMotion & {
  enabled: boolean; state: OwnshipState; fix: GpsFix | null; centerRequest: number;
};

/** Map presentation and demand; the core GPS source owns sensor acquisition. */
export function createOwnshipLayer(gps: GpsService) {
  const store = createLayerStore<OwnshipSnapshot>({ enabled: false, state: 'off', fix: null, centerRequest: 0, turnRate: null, displayTrack: null });
  let attached = false, centerOnFix = true, acquiringGps = false;
  let releaseGps: (() => void) | undefined, unsubscribe: (() => void) | undefined;
  let motionHistory: GpsFix[] = [];
  let turnHistoryStart = -Infinity;
  const resetMotionHistory = () => { motionHistory = []; turnHistoryStart = -Infinity; };

  const observeGps = () => {
    if (!attached || !store.getSnapshot().enabled) return;
    const { state, fix } = gps.getSnapshot(), previous = store.getSnapshot();
    let { turnRate, displayTrack, centerRequest } = previous;
    if (state !== 'tracking' || !fix) {
      resetMotionHistory();
      turnRate = null;
      displayTrack = null;
    } else if (fix !== previous.fix) {
      // Retain continuity breaks even between the sampled track observations.
      if (fix.track === null || fix.speed === null || (previous.fix && fix.estimated !== previous.fix.estimated)) {
        turnHistoryStart = fix.time;
      }
      ({ turnRate, displayTrack } = smoothMotion(fix, previous,
        estimateTurnRate(fix, motionHistory.filter(sample => sample.time >= turnHistoryStart))));
      motionHistory = motionHistory.filter(sample => fix.time - sample.time <= GPS_STALE_MS / 1000 + MOTION_TIME_EPSILON_SECONDS);
      if ((fix.speed !== null && fix.speed < 1) || fix.accuracy > GPS_MOTION_ACCURACY_METERS) motionHistory = [];
      if (!motionHistory.length || fix.time - motionHistory.at(-1)!.time >= GPS_MOTION_SAMPLE_MS / 1000 - MOTION_TIME_EPSILON_SECONDS) motionHistory.push(fix);
      if (centerOnFix && fix.accuracy <= GPS_MOTION_ACCURACY_METERS) { centerRequest++; centerOnFix = false; }
    }
    if (state !== previous.state || fix !== previous.fix || turnRate !== previous.turnRate || centerRequest !== previous.centerRequest) {
      store.publish({ ...previous, state, fix, turnRate, displayTrack, centerRequest });
    }
  };
  const syncDemand = () => {
    const needed = attached && store.getSnapshot().enabled;
    if (!needed) {
      unsubscribe?.(); unsubscribe = undefined;
      resetMotionHistory();
    }
    if (needed) unsubscribe ??= gps.subscribe(observeGps);
    if (needed && !releaseGps && !acquiringGps) {
      // Acquiring publishes synchronously. A subscriber may detach or disable
      // this consumer before acquire returns its release callback.
      acquiringGps = true;
      try {
        const release = gps.acquire();
        if (attached && store.getSnapshot().enabled) releaseGps = release;
        else release();
      } finally { acquiringGps = false; }
      observeGps();
    } else if (!needed && releaseGps) {
      const release = releaseGps;
      releaseGps = undefined;
      release();
    }
  };
  return {
    definition: { id: 'ownship', title: 'GPS aircraft' },
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    setEnabled(enabled: boolean) {
      if (enabled === store.getSnapshot().enabled) return;
      centerOnFix = true;
      if (!enabled) resetMotionHistory();
      store.publish({ ...store.getSnapshot(), enabled, ...(!enabled && { state: 'off' as const, fix: null, turnRate: null, displayTrack: null }) });
      syncDemand();
    },
    attach(options?: { centerOnFix: boolean }) {
      if (attached) return;
      attached = true;
      if (options) centerOnFix = options.centerOnFix;
      syncDemand();
      observeGps();
    },
    detach() {
      attached = false;
      unsubscribe?.(); unsubscribe = undefined;
      syncDemand();
      resetMotionHistory();
      store.publish({ ...store.getSnapshot(), state: 'off', fix: null, turnRate: null, displayTrack: null });
    },
    retry: gps.retry,
    center() {
      const snapshot = store.getSnapshot();
      if (snapshot.enabled && snapshot.state === 'tracking' && snapshot.fix && snapshot.fix.accuracy <= GPS_MOTION_ACCURACY_METERS) {
        store.publish({ ...snapshot, centerRequest: snapshot.centerRequest + 1 });
      }
    },
  };
}
export type OwnshipLayer = ReturnType<typeof createOwnshipLayer>;
