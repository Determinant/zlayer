import type { Map as MapLibreMap } from 'maplibre-gl';
import { TrackBearing } from './track-bearing';
import type { HeadingSource } from '../../core/map/heading';
import type { LayerStore } from '../../core/layers/store';
import { distanceMeters, GPS_MOTION_ACCURACY_METERS, type GpsFix } from '../../core/gps/position';

type CameraFix = Pick<GpsFix, 'coordinates' | 'accuracy' | 'track' | 'time'> & Partial<Pick<GpsFix, 'speed' | 'estimated'>>;
export type OrientationSource = LayerStore<{
  enabled: boolean; state: string; fix?: CameraFix | null | undefined; centerRequest: number;
  centerRequestKind: 'initial' | 'explicit';
}> & Partial<HeadingSource>;
type CameraMap = Pick<MapLibreMap, 'getCenter' | 'project' | 'getZoom' | 'getBearing' | 'isMoving' | 'easeTo' | 'stop' | 'on' | 'off'>;
type CameraRequest = 'follow' | 'initial' | 'center' | 'resume' | null;

/** Sole owner of GPS camera movement. The renderer only owns aircraft features. */
export function createGpsCamera(map: CameraMap, source: OrientationSource, initialTrackUp: boolean, changed: () => void) {
  let trackUp = initialTrackUp;
  let lastFix: CameraFix | null = null;
  let lastRequest = source.getSnapshot().centerRequest;
  let enabled = source.getSnapshot().enabled;
  let initialCenterAllowed = true;
  let pending: CameraRequest = null;
  let activeRequest: CameraRequest = null;
  let browsing = false;
  const holds = new Set<'pointer' | 'inspection'>();
  let following = false, disposed = false, updateQueued = false;
  const owner = {};
  const heading = new TrackBearing();
  let releaseHeading: (() => void) | undefined;
  let acquiringHeading = false;
  const syncHeading = () => {
    const fix = usableFix();
    const needed = !disposed && trackUp && !browsing && fix?.track != null && fix.accuracy <= 50
      && (fix.speed ?? 0) >= 10 && !fix.estimated;
    if (!needed) {
      const release = releaseHeading; releaseHeading = undefined;
      release?.(); heading.clearSensor();
    } else if (!releaseHeading && !acquiringHeading && source.acquireHeading) {
      acquiringHeading = true;
      try {
        const release = source.acquireHeading(sample => {
          if (disposed || !trackUp || browsing || !usableFix()) return;
          heading.observeHeading(sample, performance.now() / 1000);
          update();
        });
        if (disposed || !trackUp || browsing || usableFix() !== fix) release();
        else releaseHeading = release;
      } finally { acquiringHeading = false; }
    }
  };
  const usableFix = () => {
    const snapshot = source.getSnapshot();
    return snapshot.enabled && snapshot.state === 'tracking' && snapshot.fix
      && snapshot.fix.accuracy <= GPS_MOTION_ACCURACY_METERS ? snapshot.fix : null;
  };
  const desiredBearing = () => trackUp ? !browsing && usableFix()?.track != null ? heading.read() : null : 0;
  // Fresh fixes and interrupted animations cannot replace a newer explicit
  // request. Position always comes from the latest usable fix when dispatched.
  const retainRequest = (request: CameraRequest) => {
    if (request && (!pending || pending === 'follow')) pending = request;
  };
  const cancel = () => {
    pending = null;
    activeRequest = null;
    if (following) { following = false; map.stop(); }
  };
  const update = () => {
    if (disposed) return;
    const fix = usableFix();
    if (!fix) cancel();
    // Both first-fix/explicit centering and track following respect user motion.
    if (holds.size || map.isMoving()) return;
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
      const moved = request !== 'follow'
        ? Math.abs(longitude - current.lng) > 1e-9 || Math.abs(lat - current.lat) > 1e-9
        : significant && Math.hypot(position.x - origin.x, position.y - origin.y) >= 0.5;
      if (moved) center = target;
    }
    const bearing = desiredBearing();
    const difference = bearing === null ? 0 : ((bearing - map.getBearing() + 540) % 360) - 180;
    const centering = request === 'center' || request === 'initial';
    const zoom = centering ? Math.max(map.getZoom(), 9) : map.getZoom();
    if (center || Math.abs(difference) > 0.01 || zoom !== map.getZoom()) {
      activeRequest = request;
      following = !!fix && (request !== null || trackUp);
      map.easeTo({ ...(center && { center }), ...(bearing !== null && { bearing }), zoom,
        duration: centering || request === 'resume' ? 500 : 250 },
      { gpsCamera: following && request !== 'center' && request !== 'resume', gpsCameraOwner: owner });
    }
  };
  const observe = () => {
    const snapshot = source.getSnapshot(), fix = usableFix(), request = snapshot.centerRequest;
    if (snapshot.enabled && !enabled) { initialCenterAllowed = true; browsing = false; }
    enabled = snapshot.enabled;
    if (!fix || fix.track === null) heading.reset();
    else if (trackUp && fix !== lastFix) heading.observeGps(fix.track, fix.time);
    if (fix && trackUp && !browsing && fix !== lastFix) retainRequest('follow');
    if (fix && request !== lastRequest) {
      if (snapshot.centerRequestKind === 'explicit') {
        browsing = false;
        pending = 'center';
      } else if (initialCenterAllowed) pending = 'initial';
    }
    lastFix = fix; lastRequest = request;
    syncHeading();
    changed();
    update();
  };
  const moveStart = (event: { type: string; gpsCameraOwner?: unknown; browseCamera?: boolean; originalEvent?: unknown }) => {
    if (event.gpsCameraOwner !== owner) following = false;
    // Explicit fits/focus and physical pan/rotation own the view until Follow.
    // Zoom alone and resize events do not cancel the selected following mode.
    const key = (event.originalEvent as { key?: string } | undefined)?.key;
    if (event.browseCamera || event.originalEvent && (event.type === 'dragstart' || event.type === 'rotatestart' || key?.startsWith('Arrow'))) {
      browsing = trackUp;
      initialCenterAllowed = false;
      pending = activeRequest = null;
      syncHeading();
      changed();
    }
  };
  const moveEnd = () => {
    following = false;
    activeRequest = null;
    // stop()/jumpTo()/easeTo() can emit the previous moveend before installing
    // their next camera. Reconcile after that command completes, never inside it.
    if (updateQueued) return;
    updateQueued = true;
    queueMicrotask(() => { updateQueued = false; update(); });
  };
  const unsubscribe = source.subscribe(observe);
  map.on('movestart', moveStart);
  map.on('dragstart', moveStart);
  map.on('rotatestart', moveStart);
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
    waiting: () => trackUp && (usableFix()?.track == null || heading.read() === null),
    browsing: () => browsing,
    canResume: () => !!usableFix(),
    hold(reason: 'pointer' | 'inspection', value: boolean) {
      if (disposed || holds.has(reason) === value) return;
      if (value) {
        holds.add(reason);
        // Keep the latest demand, but stop an animation already under the finger.
        if (following) {
          retainRequest(activeRequest);
          following = false;
          map.stop();
        }
      } else {
        holds.delete(reason);
        update();
      }
    },
    resume() {
      if (disposed) return;
      browsing = false;
      initialCenterAllowed = true;
      const fix = usableFix();
      heading.reset();
      if (trackUp && fix?.track != null) heading.observeGps(fix.track, fix.time);
      if (fix) pending = 'resume';
      syncHeading(); changed(); update();
    },
    setTrackUp(value: boolean) {
      trackUp = value;
      browsing = false;
      if (value) initialCenterAllowed = true;
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
      map.off('dragstart', moveStart);
      map.off('rotatestart', moveStart);
      map.off('moveend', moveEnd);
      cancel();
    },
  };
}
