import type { Map as MapLibreMap } from 'maplibre-gl';
import { TrackBearing } from './track-bearing';
import type { HeadingSource } from '../../core/map/heading';
import type { LayerStore } from '../../core/layers/store';
import { distanceMeters, GPS_MOTION_ACCURACY_METERS, type GpsFix } from '../../core/gps/position';

type CameraFix = Pick<GpsFix, 'coordinates' | 'accuracy' | 'track' | 'time'> & Partial<Pick<GpsFix, 'speed' | 'estimated'>>;
export type OrientationSource = LayerStore<{
  enabled: boolean; state: string; fix?: CameraFix | null | undefined; centerRequest: number;
}> & Partial<HeadingSource>;
type CameraMap = Pick<MapLibreMap, 'getCenter' | 'project' | 'getZoom' | 'getBearing' | 'isMoving' | 'easeTo' | 'stop' | 'on' | 'off'>;

/** Sole owner of GPS camera movement. The renderer only owns aircraft features. */
export function createGpsCamera(map: CameraMap, source: OrientationSource, initialTrackUp: boolean, changed: () => void) {
  let trackUp = initialTrackUp;
  let lastFix: CameraFix | null = null;
  let lastRequest = source.getSnapshot().centerRequest;
  let pending: 'follow' | 'center' | null = null;
  let following = false, disposed = false, updateQueued = false;
  const owner = {};
  const heading = new TrackBearing();
  let releaseHeading: (() => void) | undefined;
  let acquiringHeading = false;
  const syncHeading = () => {
    const fix = usableFix();
    const needed = !disposed && trackUp && fix?.track != null && fix.accuracy <= 50
      && (fix.speed ?? 0) >= 10 && !fix.estimated;
    if (!needed) {
      const release = releaseHeading; releaseHeading = undefined;
      release?.(); heading.clearSensor();
    } else if (!releaseHeading && !acquiringHeading && source.acquireHeading) {
      acquiringHeading = true;
      try {
        const release = source.acquireHeading(sample => {
          if (disposed || !trackUp || !usableFix()) return;
          heading.observeHeading(sample, performance.now() / 1000);
          update();
        });
        if (disposed || !trackUp || usableFix() !== fix) release();
        else releaseHeading = release;
      } finally { acquiringHeading = false; }
    }
  };
  const usableFix = () => {
    const snapshot = source.getSnapshot();
    return snapshot.enabled && snapshot.state === 'tracking' && snapshot.fix
      && snapshot.fix.accuracy <= GPS_MOTION_ACCURACY_METERS ? snapshot.fix : null;
  };
  const desiredBearing = () => trackUp ? usableFix()?.track != null ? heading.read() : null : 0;
  const cancel = () => {
    pending = null;
    if (following) { following = false; map.stop(); }
  };
  const update = () => {
    if (disposed) return;
    const fix = usableFix();
    if (!fix) cancel();
    // Both first-fix/explicit centering and track following respect user motion.
    if (map.isMoving()) return;
    const request = pending;
    pending = null;
    let center: [number, number] | undefined;
    if (fix && request) {
      const current = map.getCenter();
      const [lng, lat] = fix.coordinates;
      const longitude = lng + 360 * Math.round((current.lng - lng) / 360);
      const target: [number, number] = [longitude, lat];
      const position = map.project(target), origin = map.project(current);
      // With no reliable motion, stay within the fix's uncertainty rather than
      // chase parked GPS drift at high zoom. Accumulated travel still recenters.
      const moving = fix.track !== null && (fix.speed ?? 0) >= 1;
      const significant = moving || distanceMeters([current.lng, current.lat], target) > Math.max(5, 2 * fix.accuracy);
      const moved = request === 'center'
        ? Math.abs(longitude - current.lng) > 1e-9 || Math.abs(lat - current.lat) > 1e-9
        : significant && Math.hypot(position.x - origin.x, position.y - origin.y) >= 0.5;
      if (moved) center = target;
    }
    const bearing = desiredBearing();
    const difference = bearing === null ? 0 : ((bearing - map.getBearing() + 540) % 360) - 180;
    const zoom = request === 'center' ? Math.max(map.getZoom(), 9) : map.getZoom();
    if (center || Math.abs(difference) > 0.01 || zoom !== map.getZoom()) {
      following = !!fix && (request !== null || trackUp);
      map.easeTo({ ...(center && { center }), ...(bearing !== null && { bearing }), zoom,
        duration: request === 'center' ? 500 : 250 }, { gpsCamera: following && request !== 'center', gpsCameraOwner: owner });
    }
  };
  const observe = () => {
    const fix = usableFix(), request = source.getSnapshot().centerRequest;
    if (!fix || fix.track === null) heading.reset();
    else if (trackUp && fix !== lastFix) heading.observeGps(fix.track, fix.time);
    if (fix && trackUp && fix !== lastFix && pending !== 'center') pending = 'follow';
    if (fix && request !== lastRequest) pending = 'center';
    lastFix = fix; lastRequest = request;
    syncHeading();
    changed();
    update();
  };
  const moveStart = (event: { type: string; gpsCameraOwner?: unknown }) => {
    if (event.gpsCameraOwner !== owner) following = false;
  };
  const moveEnd = () => {
    following = false;
    // stop()/jumpTo()/easeTo() can emit the previous moveend before installing
    // their next camera. Reconcile after that command completes, never inside it.
    if (updateQueued) return;
    updateQueued = true;
    queueMicrotask(() => { updateQueued = false; update(); });
  };
  const unsubscribe = source.subscribe(observe);
  map.on('movestart', moveStart);
  map.on('moveend', moveEnd);
  // Initial state is reconciled without invoking the caller before construction returns.
  const initialFix = usableFix();
  lastFix = initialFix;
  if (trackUp && initialFix) {
    pending = 'follow';
    if (initialFix.track !== null) heading.observeGps(initialFix.track, initialFix.time);
  }
  syncHeading();
  update();
  return {
    getTargetBearing: () => desiredBearing() ?? map.getBearing(),
    waiting: () => trackUp && desiredBearing() === null,
    setTrackUp(value: boolean) {
      trackUp = value;
      cancel();
      heading.reset();
      const fix = usableFix();
      if (trackUp && fix?.track != null) heading.observeGps(fix.track, fix.time);
      syncHeading();
      if (trackUp && usableFix()) pending = 'follow';
      changed();
      update();
    },
    dispose() {
      disposed = true;
      syncHeading();
      unsubscribe();
      map.off('movestart', moveStart);
      map.off('moveend', moveEnd);
      cancel();
    },
  };
}
