import { createLayerStore } from '../../core/layers/store';
import type { GpsService, GpsState } from '../../core/gps/service';
import { GPS_MOTION_ACCURACY_METERS, GPS_MOTION_SAMPLE_MS, GPS_STALE_MS, type GpsFix } from '../../core/gps/position';
import { estimateTurnRate } from './position';

export type OwnshipState = GpsState;
export type OwnshipSnapshot = {
  enabled: boolean; state: OwnshipState; fix: GpsFix | null; centerRequest: number;
  /** Recent GPS ground-track turn rate in degrees per second, clockwise positive. */
  turnRate: number | null;
};

/** Map presentation and demand; the core GPS source owns sensor acquisition. */
export function createOwnshipLayer(gps: GpsService) {
  const store = createLayerStore<OwnshipSnapshot>({ enabled: false, state: 'off', fix: null, centerRequest: 0, turnRate: null });
  let attached = false, centerOnFix = true, acquiringGps = false;
  let releaseGps: (() => void) | undefined, unsubscribe: (() => void) | undefined;
  let motionHistory: GpsFix[] = [];
  let turnHistoryStart = -Infinity;

  const observeGps = () => {
    if (!attached || !store.getSnapshot().enabled) return;
    const { state, fix } = gps.getSnapshot(), previous = store.getSnapshot();
    let turnRate = previous.turnRate, centerRequest = previous.centerRequest;
    if (state !== 'tracking' || !fix) {
      motionHistory = [];
      turnHistoryStart = -Infinity;
      turnRate = null;
    } else if (fix !== previous.fix) {
      // Retain continuity breaks even between the sampled track observations.
      if (fix.track === null || fix.speed === null || (previous.fix && fix.estimated !== previous.fix.estimated)) {
        turnHistoryStart = fix.timestamp;
      }
      turnRate = estimateTurnRate(fix, motionHistory.filter(sample => sample.timestamp >= turnHistoryStart));
      motionHistory = motionHistory.filter(sample => fix.timestamp - sample.timestamp <= GPS_STALE_MS);
      if ((fix.speed !== null && fix.speed < 1) || fix.accuracy > GPS_MOTION_ACCURACY_METERS) motionHistory = [];
      if (!motionHistory.length || fix.timestamp - motionHistory.at(-1)!.timestamp >= GPS_MOTION_SAMPLE_MS) motionHistory.push(fix);
      if (centerOnFix && fix.accuracy <= GPS_MOTION_ACCURACY_METERS) { centerRequest++; centerOnFix = false; }
    }
    if (state !== previous.state || fix !== previous.fix || turnRate !== previous.turnRate || centerRequest !== previous.centerRequest) {
      store.publish({ ...previous, state, fix, turnRate, centerRequest });
    }
  };
  const syncDemand = () => {
    const needed = attached && store.getSnapshot().enabled;
    if (!needed) {
      unsubscribe?.(); unsubscribe = undefined;
      motionHistory = [];
      turnHistoryStart = -Infinity;
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
      if (!enabled) { motionHistory = []; turnHistoryStart = -Infinity; }
      store.publish({ ...store.getSnapshot(), enabled, ...(!enabled && { state: 'off' as const, fix: null, turnRate: null }) });
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
      motionHistory = [];
      turnHistoryStart = -Infinity;
      store.publish({ ...store.getSnapshot(), state: 'off', fix: null, turnRate: null });
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
