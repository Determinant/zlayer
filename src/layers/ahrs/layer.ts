import { ESTIMATOR_MODEL } from './estimator/state-layout.js';
import { createLayerStore } from '../../core/layers/store';
import type { GpsService } from '../../core/gps/service';
import { Ahrs, DEFAULTS, validateImuSample } from './estimator/ahrs';
import { FlightAlignment, MIN_FLIGHT_GPS_SPEED, type FlightAlignmentIssue, type FlightAlignmentReason } from './estimator/flight-alignment';
import { G, RAD, rotate, type Quaternion } from './estimator/math';
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
  const createFilter = () => new Ahrs(estimatorOptions, observation => recorder.record('innovation', environment.now(), observation));
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
  const publish = () => { if (visible) store.publish(readSnapshot()); };
  const updateDisplayTimer = () => {
    clearInterval(timer); timer = undefined;
    if (visible && motion) timer = setInterval(publish, 50);
  };
  const observeGps = () => {
    const { fix, time, live, usable } = gpsState();
    recorder.record('gps', environment.now(), { ...gps.getSnapshot(), time,
      forwarded: !!fix && time > lastFix && time <= environment.now() + .1 && hasAlignment && live });
    if (fix && time > lastFix && time <= environment.now() + 0.1) {
      lastFix = time;
      const sample = { time, accuracy: fix.accuracy, speed: fix.speed, track: fix.track, estimated: fix.estimated };
      if (phase === 'calibrating') alignment.observeGps(sample);
      if (hasAlignment && live) filter.updateGps({ ...sample, altitude: fix.altitude ?? null, altitudeAccuracy: fix.altitudeAccuracy ?? null });
      const attitude = hasAlignment ? filter.getState(environment.now()) : null;
      if (attitude) headingReference.observeAttitude(attitude, environment.now());
      if (usable && (hasAlignment || heading === undefined)) {
        headingReference.observeGps(time, fix.track!, environment.now(), attitude);
      }
    }
    publish();
  };
  const reportMotionIssue = (issue: string) => {
    motionIssue = true;
    message = issue;
    recorder.record('issue', environment.now(), { message, recoverable: true });
    publish();
  };
  const magnetic = (value: MagneticSample) => {
    magneticMessage = '';
    const forwarded = hasAlignment && phase === 'ready';
    const sample: MagneticSample = value.source === 'webkit-compass' ? { ...value, axis: rotate(trim, value.axis) }
      : { ...value, vector: rotate(trim, value.vector) };
    recorder.record('magnetic', environment.now(), { sample, forwarded });
    if (forwarded) filter.updateMagnetic(sample);
  };
  const magneticIssue = (reason: string) => {
    magneticMessage = reason;
    recorder.record('magnetic-issue', environment.now(), { reason });
    filter.magneticUnavailable(reason);
  };
  const sample = (value: ImuSample, raw?: MotionReading) => {
    try { validateImuSample(value); }
    catch {
      recorder.record('imu', environment.now(), { sample: value, raw, phase, applied: false });
      reportMotionIssue('Skipped an invalid motion reading. Waiting for fresh readings.');
      return;
    }
    if (value.time <= lastImu) return;
    lastImu = value.time;
    recorder.record('imu', environment.now(), { sample: value, raw, phase,
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
      } else if (phase === 'ready') {
        const corrected = { time: value.time, gyro: rotate(trim, value.gyro), specificForce: rotate(trim, value.specificForce) };
        const attitude = filter.update(corrected);
        headingReference.observeImu(corrected, attitude, environment.now());
      }
      if (recorder.accepting() && value.time >= nextRecordedState) {
        recorder.record('state', environment.now(), readSnapshot());
        nextRecordedState = value.time + .1;
        if (hasAlignment && value.time >= nextRecordedCovariance) {
          recorder.record('covariance', environment.now(), Array.from(filter.getCovariance()));
          nextRecordedCovariance = value.time + 1;
        }
      }
    } catch {
      failMotion('Motion readings were interrupted or invalid. Recalibrate when steady.');
    }
  };
  const release = () => {
    // Invalidate callbacks on failure as well as explicit stop/recalibration.
    generation++;
    motion?.stop(); motion = undefined;
    clearInterval(timer); timer = undefined;
    unsubscribe?.(); unsubscribe = undefined;
    releaseGps?.(); releaseGps = undefined;
  };
  const failMotion = (issue: string) => {
    release();
    phase = 'error'; message = issue;
    recorder.record('issue', environment.now(), { message });
    publish();
  };
  const stop = () => {
    recorder.record('stop', environment.now(), {});
    void recorder.stop();
    release();
    phase = 'idle'; hasAlignment = false; message = ''; motionIssue = false;
    // The layer stays mounted when stopped. Release replay covariances and the
    // independent heading trajectory instead of retaining the last session.
    filter.reset();
    headingReference.reset();
    alignment.reset();
    store.publish(initial());
  };
  return {
    definition: { id: 'ahrs', title: 'AHRS' },
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
      release();
      const session = generation;
      phase = 'requesting'; message = ''; hasAlignment = false; motionIssue = false;
      filter.reset();
      headingReference.reset(trueHeading, environment.now());
      magneticMessage = '';
      lastImu = lastFix = -Infinity;
      heading = trueHeading;
      alignment.reset();
      publish();
      try {
        const sensor = environment.motion(mount,
          (value, raw) => { if (session === generation) sample(value, raw); },
          issue => { if (session === generation) reportMotionIssue(issue); }, {
            sample: value => { if (session === generation) magnetic(value); },
            issue: reason => { if (session === generation) magneticIssue(reason); },
          });
        if (session !== generation) { sensor.stop(); return; }
        motion = sensor;
        // Start permission request before any await, in the pilot's click handler.
        await sensor.start();
        if (session !== generation) { sensor.stop(); return; }
        phase = 'calibrating';
        const releaseLocation = gps.acquire();
        // Acquiring may synchronously notify another consumer that stops us.
        if (session !== generation) { releaseLocation(); return; }
        releaseGps = releaseLocation;
        unsubscribe = gps.subscribe(() => { if (session === generation) observeGps(); });
        observeGps();
        updateDisplayTimer();
      } catch (error) {
        if (session !== generation) return;
        failMotion(error instanceof Error ? error.message : 'Motion sensors are unavailable.');
      }
    },
    retryGps: () => gps.retry(),
    stop,
  };
}
export type AhrsLayer = ReturnType<typeof createAhrsLayer>;
