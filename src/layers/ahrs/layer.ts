import type { HeadingListener, HeadingSample } from '../../core/map/heading';
import { ESTIMATOR_MODEL } from './estimator/state-layout.js';
import { createLayerEvents } from '../../core/layers/events';
import { createLayerStore } from '../../core/layers/store';
import type { GpsService } from '../../core/gps/service';
import { Ahrs, DEFAULTS, validateImuSample } from './estimator/ahrs';
import { FlightAlignment, MIN_FLIGHT_GPS_SPEED, type FlightAlignmentIssue, type FlightAlignmentReason } from './estimator/flight-alignment';
import { G, RAD, norm, rotate, rotationBetween, type Quaternion } from './estimator/math';
import type { Mount } from './estimator/device-frame';
import type { Attitude, ImuSample, MagneticSample } from './estimator/types';
import { createMotionSensor, type MotionFactory, type MotionPort, type MotionReading } from './motion';
import { createAhrsRecorder, type AhrsRecorder } from './recording';
import { validPosition, type Position } from './navigation';
import { HeadingReference, type HsiHeading } from './heading-reference';

/** Core owns acquisition and timing; AHRS only leases and evaluates its fixes. */
export type AhrsGpsSource = Pick<GpsService, 'getSnapshot' | 'subscribe' | 'acquire' | 'retry'>;
type Phase = 'idle' | 'requesting' | 'calibrating' | 'ready' | 'error';
type Warning = '' | 'Calibration' | 'Motion' | 'No GPS' | 'Low Speed' | 'Uncertainty';
export type AhrsSnapshot = {
  phase: Phase;
  attitude: Attitude | null;
  /** Persistent geographic HSI reference; GPS-seeded heading remains provisional. */
  hsiHeading: HsiHeading | null;
  crossed: boolean;
  warning: Warning;
  message: string;
  calibrationReason: FlightAlignmentReason;
  progress: number;
  gpsLive: boolean;
  /** Fresh GPS velocity also meets the flight-movement gate. */
  gpsUsable: boolean;
  gpsMessage: string;
  track: number | null;
  speed: number | null;
  /** GPS altitude in meters; not pressure altitude. */
  altitude: number | null;
  /** GPS vertical accuracy in meters; null when unreported. */
  altitudeAccuracy: number | null;
  /** Monotonic seconds, matching the motion/animation clock. */
  gpsTime: number | null;
  position: Position | null;
  trueHeading: boolean;
};
type Environment = { now(): number; timeOrigin: number; motion: MotionFactory; recorder?: AhrsRecorder };

const initial = (): AhrsSnapshot => ({ phase: 'idle', attitude: null, hsiHeading: null, crossed: true,
  warning: 'Calibration', message: '', calibrationReason: 'collecting-imu', progress: 0,
  gpsLive: false, gpsUsable: false, gpsMessage: 'Waiting for GPS.', track: null, speed: null,
  altitude: null, altitudeAccuracy: null, gpsTime: null, position: null, trueHeading: false });

function calibrationMessage(issue: FlightAlignmentIssue): string {
  if (issue.kind === 'angular-scatter') {
    return `Angular movement is ${(issue.value / RAD).toFixed(2)}° RMS (limit ${(issue.limit / RAD).toFixed(2)}°). Waiting for a steadier level pose.`;
  }
  if (issue.kind === 'force-magnitude') {
    return `Accelerometer magnitude differs from gravity by ${(issue.value / G).toFixed(2)} g (limit ${(issue.limit / G).toFixed(2)} g). Waiting for steady gravity readings.`;
  }
  const gyro = issue.kind.startsWith('gyro');
  const units = gyro ? '°/s' : ' m/s²', scale = gyro ? RAD : 1;
  const reading = `${(issue.value / scale).toFixed(2)}${units} (limit ${(issue.limit / scale).toFixed(2)}${units})`;
  const label = issue.kind === 'gyro-rate' ? 'Gyro average is too high'
    : issue.kind.endsWith('noise') ? `${gyro ? 'Gyro' : 'Accelerometer'} readings are too noisy`
    : `${gyro ? 'Gyro' : 'Accelerometer'} averages are changing`;
  return `${label}: ${reading}. Keep the device supported; calibration is still waiting.`;
}

export function createAhrsLayer(gps: AhrsGpsSource, environment: Environment = {
  now: () => performance.now() / 1000, timeOrigin: performance.timeOrigin, motion: createMotionSensor,
}) {
  const store = createLayerStore<AhrsSnapshot>(initial());
  const recorder = environment.recorder ?? createAhrsRecorder();
  const alignment = new FlightAlignment({ requireVerticalEvidence: false, allowUnaided: true, pauseOnGap: true });
  const headingReference = new HeadingReference();
  const estimatorOptions = { ...DEFAULTS, recoverAfterGap: true };
  let mode: 'heading' | 'instruments' | null = null;
  // Instrument recordings/replay start from a confirmed alignment. Automatic
  // map sessions neither own the recorder nor inject unaligned replay inputs.
  const recordSensor = (type: string, data: unknown) => {
    if (mode === 'instruments') recorder.record(type, environment.now(), data);
  };
  const createFilter = () => new Ahrs(estimatorOptions, observation => recordSensor('innovation', observation));
  const headingEvents = createLayerEvents<HeadingSample | null>();
  const headingLeases = new Set<() => void>();
  let lastHeadingTime = -Infinity;
  let headingAvailable = false, automaticTrimPending = false;
  const filterActive = () => hasAlignment || mode === 'heading';
  let filter = createFilter(), trim: Quaternion = [1, 0, 0, 0];
  let motion: MotionPort | undefined;
  let releaseGps: (() => void) | undefined, unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0, lastFix = -Infinity, lastImu = -Infinity;
  let phase: Phase = 'idle', message = '', heading: number | undefined;
  let hasAlignment = false;
  let motionIssue = false;
  let magneticMessage = '';
  let visible = true;
  let mount: Mount = 'upright', nextRecordedState = 0, nextRecordedCovariance = 0;

  const gpsState = () => {
    // Only the active sensor session owns GPS updates and their expiry clock.
    // Another consumer may keep the shared source live after this session stops.
    const snapshot = releaseGps ? gps.getSnapshot() : { state: 'off', fix: null };
    const fix = snapshot.fix;
    const time = fix?.time ?? -Infinity;
    const age = environment.now() - time;
    const live = snapshot.state === 'tracking' && fix !== null && age >= -0.1 && age <= 3 &&
      fix.accuracy >= 0 && fix.accuracy <= 50 && !fix.estimated &&
      fix.speed !== null && Number.isFinite(fix.speed) && fix.speed >= 0 &&
      (fix.speed < MIN_FLIGHT_GPS_SPEED || (fix.track !== null && Number.isFinite(fix.track)));
    const usable = live && fix.speed! >= MIN_FLIGHT_GPS_SPEED;
    const reason = live && !usable ? 'GPS received below about 20 kt. Steady velocity can still aid tilt; heading alignment needs more motion.'
      : snapshot.state === 'denied' ? 'Allow location access in this site’s settings, then retry GPS.'
      : snapshot.state === 'unsupported' ? 'GPS is unavailable on this device.'
      : snapshot.state === 'insecure' ? 'Location access requires HTTPS.'
      : snapshot.state === 'paused' ? 'Keep this app in the foreground for GPS.'
      : fix?.estimated ? 'Waiting for GPS-reported speed and track.'
      : 'Waiting for a fresh, accurate GPS speed and track.';
    return { fix, time, live, usable, reason };
  };
  const readSnapshot = (): AhrsSnapshot => {
    if (mode === 'heading') return initial();
    const now = environment.now(), location = gpsState();
    const attitude = hasAlignment ? filter.getState(now) : null;
    const calibration = alignment.snapshot(now);
    let warning: Warning = 'Calibration', detail = message;
    if (phase === 'calibrating' && calibration.issue) detail ||= calibrationMessage(calibration.issue);
    if (phase === 'ready') {
      if (attitude?.status === 'interrupted') {
        // A latched estimator failure cannot recover on the next motion event.
        // It also overrides any message left by a recoverable sensor issue.
        detail = 'Attitude estimation stopped. Recalibrate when steady.';
      } else if (motionIssue || now - lastImu > 0.5 || attitude?.status === 'stale') {
        warning = 'Motion';
        detail ||= 'Motion readings paused. Keeping the last attitude; waiting to resume automatically.';
      } else {
        // Growing uncertainty does not invalidate calibration or stop live IMU attitude.
        warning = !location.live ? 'No GPS' : !location.usable ? 'Low Speed'
          : attitude?.status === 'degraded' ? 'Uncertainty' : '';
        if (attitude?.status === 'degraded') {
          detail ||= 'Attitude uncertainty is high. Attitude remains visible; recalibrate when steady.';
        }
      }
    }
    return { phase, attitude, hsiHeading: headingReference.read(now), crossed: warning !== '', warning, message: detail,
      calibrationReason: phase === 'calibrating' && now - lastImu > 0.5 ? 'imu-stale' : calibration.reason,
      progress: phase === 'ready' ? 1 : ['collecting-imu', 'imu-stale', 'pose-changed'].includes(calibration.reason)
        ? Math.min(.99, calibration.elapsed / calibration.requiredSeconds) : 0,
      gpsLive: location.live, gpsUsable: location.usable, gpsMessage: location.usable ? '' : location.reason,
      track: location.live ? location.fix!.track : null,
      position: location.live && validPosition(location.fix?.coordinates) ? location.fix.coordinates : null,
      altitude: location.live && location.fix?.altitude != null && Number.isFinite(location.fix.altitude) ? location.fix.altitude : null,
      altitudeAccuracy: location.live ? location.fix?.altitudeAccuracy ?? null : null,
      gpsTime: location.live ? location.time : null,
      speed: location.live ? location.fix!.speed : null,
      trueHeading: attitude !== null && attitude.headingStatus === 'tracking' };
  };
  const publishHeading = (clear = false) => {
    if (!headingLeases.size) return;
    const now = environment.now();
    const usable = !clear && filterActive() && gpsState().usable && !motionIssue && now - lastImu <= .5;
    if (usable && now - lastHeadingTime < .25) return;
    let sample: HeadingSample | null = null;
    if (usable) {
      const attitude = filter.getState(now), heading = headingReference.read(now);
      if (heading && !['waiting', 'interrupted', 'stale'].includes(attitude.status)
        && attitude.tiltStd <= 20 && Math.abs(Math.cos(attitude.pitch * RAD)) >= .1) {
        sample = { degrees: heading.degrees, time: lastImu, frame: generation };
      }
    }
    if (sample ? sample.time - lastHeadingTime < .25 : !headingAvailable) return;
    headingAvailable = sample !== null;
    lastHeadingTime = sample?.time ?? -Infinity;
    headingEvents.emit(sample);
  };
  const publish = () => { if (visible && mode !== 'heading') store.publish(readSnapshot()); };
  const updateDisplayTimer = () => {
    clearInterval(timer); timer = undefined;
    if (visible && motion && mode === 'instruments') timer = setInterval(publish, 50);
  };
  const observeGps = () => {
    const { fix, time, live, usable } = gpsState();
    recordSensor('gps', { ...gps.getSnapshot(), time,
      forwarded: !!fix && time > lastFix && time <= environment.now() + .1 && filterActive() && live });
    if (fix && time > lastFix && time <= environment.now() + 0.1) {
      lastFix = time;
      const sample = { time, accuracy: fix.accuracy, speed: fix.speed, track: fix.track, estimated: fix.estimated };
      if (phase === 'calibrating') alignment.observeGps(sample);
      if (filterActive() && live) filter.updateGps({ ...sample, altitude: fix.altitude ?? null, altitudeAccuracy: fix.altitudeAccuracy ?? null });
      const attitude = filterActive() ? filter.getState(environment.now()) : null;
      if (attitude) headingReference.observeAttitude(attitude, environment.now());
      if (usable && (filterActive() || heading === undefined)) {
        headingReference.observeGps(time, fix.track!, environment.now(), attitude);
      }
    }
    publishHeading();
    publish();
  };
  const reportMotionIssue = (issue: string) => {
    motionIssue = true;
    publishHeading(true);
    message = issue;
    recordSensor('issue', { message, recoverable: true });
    publish();
  };
  const magnetic = (value: MagneticSample) => {
    magneticMessage = '';
    const forwarded = filterActive() && (phase === 'ready' || mode === 'heading');
    const sample: MagneticSample = value.source === 'webkit-compass' ? { ...value, axis: rotate(trim, value.axis) }
      : { ...value, vector: rotate(trim, value.vector) };
    recordSensor('magnetic', { sample, forwarded });
    if (forwarded) filter.updateMagnetic(sample);
  };
  const magneticIssue = (reason: string) => {
    magneticMessage = reason;
    recordSensor('magnetic-issue', { reason });
    filter.magneticUnavailable(reason);
  };
  const sample = (value: ImuSample, raw?: MotionReading) => {
    try { validateImuSample(value); }
    catch {
      recordSensor('imu', { sample: value, raw, phase, applied: false });
      reportMotionIssue('Skipped an invalid motion reading. Waiting for fresh readings.');
      return;
    }
    if (value.time <= lastImu) return;
    lastImu = value.time;
    recordSensor('imu', { sample: value, raw, phase,
      applied: phase === 'calibrating' || phase === 'ready' });
    try {
      message = '';
      motionIssue = false;
      if (phase === 'calibrating') {
        alignment.observeImu(value);
        const candidate = alignment.snapshot(environment.now()).solution;
        if (candidate) {
          recorder.record('alignment', environment.now(), { solution: candidate, trueHeading: heading ?? null });
          trim = candidate.levelTrim;
          filter = createFilter();
          const bias = rotate(trim, candidate.gyroBias);
          filter.setGyroBias(bias, candidate.gyroBiasStd);
          filter.update({ time: candidate.time, gyro: bias, specificForce: rotate(trim, candidate.specificForce) });
          if (heading !== undefined) filter.alignHeading(heading);
          if (magneticMessage) filter.magneticUnavailable(magneticMessage);
          // The applied trim/bias own the calibration result. Its raw window is
          // no longer needed for display reads or subsequent GPS observations.
          alignment.reset();
          hasAlignment = true;
          headingReference.observeImu({ time: candidate.time, gyro: bias, specificForce: rotate(trim, candidate.specificForce) },
            filter.getState(environment.now()), environment.now());
          phase = 'ready';
          message = '';
          lastFix = -Infinity;
          observeGps();
        }
      } else if (phase === 'ready' || mode === 'heading') {
        if (automaticTrimPending) {
          // Do not advance an uninitialized filter's clock through unsettled
          // readings. Recovery from gaps requires an initialized attitude.
          if (Math.abs(norm(value.specificForce) / G - 1) > .12) return;
          // Choose a local horizontal heading frame for any fixed device mount.
          // This is a gravity bootstrap, not an aircraft level/bias calibration.
          trim = rotationBetween(value.specificForce, [0, 0, -G]);
          automaticTrimPending = false;
        }
        const corrected = { time: value.time, gyro: rotate(trim, value.gyro), specificForce: rotate(trim, value.specificForce) };
        const attitude = filter.update(corrected);
        headingReference.observeImu(corrected, attitude, environment.now());
      }
      publishHeading();
      if (mode === 'instruments' && recorder.accepting() && value.time >= nextRecordedState) {
        recordSensor('state', readSnapshot());
        nextRecordedState = value.time + .1;
        if (hasAlignment && value.time >= nextRecordedCovariance) {
          recordSensor('covariance', Array.from(filter.getCovariance()));
          nextRecordedCovariance = value.time + 1;
        }
      }
    } catch {
      failMotion('Motion readings were interrupted or invalid. Recalibrate when steady.');
    }
  };
  const release = () => {
    // Clear ownership before callbacks: releasing GPS or notifying a consumer
    // can synchronously dispose this session or start its replacement.
    const session = ++generation;
    const sensor = motion, unobserve = unsubscribe, location = releaseGps;
    motion = undefined; unsubscribe = releaseGps = undefined;
    clearInterval(timer); timer = undefined;
    sensor?.stop(); unobserve?.(); location?.();
    publishHeading(true);
    return session;
  };
  const failMotion = (issue: string) => {
    const session = release();
    if (session !== generation) return;
    phase = 'error'; message = issue;
    recordSensor('issue', { message });
    publish();
  };
  const resetSession = () => {
    const session = release();
    if (session !== generation) return session;
    mode = null;
    phase = 'idle'; hasAlignment = false; message = ''; motionIssue = false;
    // Sensor demand and recording demand have independent owners. Resetting
    // automatic heading must not end a recording prepared for calibration.
    filter.reset();
    headingReference.reset();
    alignment.reset();
    store.publish(initial());
    return session;
  };
  const stopRecording = () => {
    recorder.record('stop', environment.now(), {});
    void recorder.stop();
  };
  // One sensor/filter/GPS session serves instrument and heading consumers. A
  // heading lease never asserts a calibrated instrument level reference.
  const startSensors = async (session: number) => {
    if (session !== generation) return;
    try {
      const sensor = environment.motion(mount,
        (value, raw) => { if (session === generation) sample(value, raw); },
        issue => { if (session === generation) reportMotionIssue(issue); }, {
          sample: value => { if (session === generation) magnetic(value); },
          issue: reason => { if (session === generation) magneticIssue(reason); },
        });
      if (session !== generation) { sensor.stop(); return; }
      motion = sensor;
      await sensor.start(); // Permission request stays in the initiating gesture.
      if (session !== generation) { sensor.stop(); return; }
      if (mode === 'instruments') phase = 'calibrating';
      const releaseLocation = gps.acquire();
      if (session !== generation) { releaseLocation(); return; }
      releaseGps = releaseLocation;
      unsubscribe = gps.subscribe(() => { if (session === generation) observeGps(); });
      observeGps();
      updateDisplayTimer();
    } catch (error) {
      if (session !== generation) return;
      failMotion(error instanceof Error ? error.message : 'Motion sensors are unavailable.');
    }
  };
  const startHeading = () => {
    const session = resetSession();
    if (session !== generation || !headingLeases.size) return;
    mode = 'heading';
    // Automatic gravity initialization has no confirmed level pose or measured
    // gyro bias. Preserve that uncertainty; GPS seeds only a display reference.
    filter = new Ahrs({ ...estimatorOptions, initialTiltStd: 15 });
    trim = [1, 0, 0, 0]; heading = undefined; automaticTrimPending = true;
    lastImu = lastFix = -Infinity;
    magneticMessage = '';
    void startSensors(session);
  };
  return {
    definition: { id: 'ahrs', title: 'AHRS' },
    acquireHeading(listener: HeadingListener) {
      const unsubscribe = headingEvents.events.subscribe(listener);
      const release = () => {
        if (!headingLeases.delete(release)) return;
        unsubscribe();
        if (!headingLeases.size && mode === 'heading') resetSession();
      };
      headingLeases.add(release);
      if (mode === null || (mode === 'heading' && !motion)) startHeading();
      return release;
    },
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    /** Fresh display read between status publications; never advances the estimator. */
    readDisplaySnapshot: readSnapshot,
    recorder,
    startRecording(context: Record<string, unknown> = {}) {
      nextRecordedState = nextRecordedCovariance = 0;
      return recorder.start({ ...context, timeOrigin: environment.timeOrigin, estimatorModel: ESTIMATOR_MODEL, estimatorOptions,
        units: { time: 'monotonic seconds', gyro: 'rad/s', specificForce: 'm/s²', attitude: 'degrees',
          position: '[longitude, latitude] degrees', altitude: 'meters' },
        frames: { sample: 'body forward/right/down before level trim', raw: 'browser device axes before polarity/mount correction',
          covariance: 'row-major 30×30: position, velocity, local attitude error (radians), accelerometer bias, gyro bias, persistent world acceleration, world magnetic reference, body magnetic bias, transient world acceleration, cloned endpoint velocity; magnetic units are fractions of the initial field norm' },
        mount, trueHeading: heading ?? null, trim, visible, snapshot: readSnapshot(),
        covariance: hasAlignment ? Array.from(filter.getCovariance()) : null });
    },
    /** Visibility only controls display publication. Every IMU sample is integrated. */
    setVisible(value: boolean) {
      if (visible === value) return;
      visible = value;
      recorder.record('visibility', environment.now(), { visible });
      updateDisplayTimer();
      publish();
    },
    /** Call from the pilot's straight-and-level confirmation button. */
    async calibrate(nextMount: Mount = 'upright', trueHeading?: number) {
      if (trueHeading !== undefined && (!Number.isFinite(trueHeading) || trueHeading < 0 || trueHeading >= 360)) return;
      mount = nextMount;
      recorder.record('calibrate', environment.now(), { mount, trueHeading: trueHeading ?? null });
      const session = release();
      if (session !== generation) return;
      mode = 'instruments'; automaticTrimPending = false;
      phase = 'requesting'; message = ''; hasAlignment = false; motionIssue = false;
      filter = createFilter();
      headingReference.reset(trueHeading, environment.now());
      magneticMessage = '';
      lastImu = lastFix = -Infinity;
      heading = trueHeading;
      alignment.reset();
      publish();
      await startSensors(session);
    },
    retryGps: () => gps.retry(),
    stop() {
      // Instrument teardown must not restart an already automatic map session.
      stopRecording();
      if (mode === 'heading') return;
      if (headingLeases.size) startHeading();
      else resetSession();
    },
    dispose() {
      stopRecording();
      publishHeading(true);
      for (const release of headingLeases) release();
      resetSession();
    },
  };
}
export type AhrsLayer = ReturnType<typeof createAhrsLayer>;
