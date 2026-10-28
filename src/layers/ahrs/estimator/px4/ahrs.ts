import createModule from './generated/ekf.js';
import layout from './snapshot.json';
import { GroundState } from './ground-state.js';
import { G, RAD, finiteVector, norm, toEuler, wrap, type Quaternion, type Vec3 } from '../math.js';
import type { AhrsOptions, Attitude, GpsFix, ImuSample, MagneticSample, Observation, ObservationListener } from '../types.js';

import { N } from '../state-layout.js';
const { state: S, aid: A, headingSource: H } = layout;
export const DEFAULTS = Object.freeze({
  gpsAiding: true, gravityAiding: false, maxGap: .25, recoverAfterGap: false,
  // PX4 noise parameters describe readings and bias derivatives, not densities.
  gyroNoise: .015, accelNoise: .35, gyroBiasWalk: .001, accelBiasWalk: .003,
  initialGyroBiasStd: .1, initialAccelBiasStd: .2, initialTiltStd: .1 / RAD,
  initialHeadingStd: 10, gpsVelocityStd: 1.5, maxTiltStd: 10,
});

// A single embedded module owns separate, explicitly disposable filter instances.
const native = await createModule({ print() {}, printErr: message => console.error(`PX4: ${message}`) });
const cleanup = new FinalizationRegistry<number>(pointer => native._px4_destroy(pointer));
type Stats = { accepted: number; rejected: number; nis: number | null; reason: string; lastAttempt: number; lastFusion: number; lastAccepted: boolean };
const stats = (): Stats => ({ accepted: 0, rejected: 0, nis: null, reason: 'Waiting for observations', lastAttempt: -Infinity, lastFusion: -Infinity, lastAccepted: false });
const vector = (s: Float64Array, i: number): Vec3 => [s[i]!, s[i + 1]!, s[i + 2]!];
const sigma = (variance: number) => Math.sqrt(Math.max(0, variance));
const quaternion = (s: Float64Array): Quaternion => [s[S.QUATERNION]!, s[S.QUATERNION + 1]!, s[S.QUATERNION + 2]!, s[S.QUATERNION + 3]!];
const sigmas = (s: Float64Array, i: number): Vec3 => [sigma(s[i]!), sigma(s[i + 1]!), sigma(s[i + 2]!)];

export function validateImuSample({ time, gyro, specificForce }: ImuSample): void {
  if (!Number.isFinite(time) || !finiteVector(gyro) || !finiteVector(specificForce)) throw new TypeError('IMU samples must be finite');
  if (norm(gyro) > 35 || norm(specificForce) > 20 * G) throw new RangeError('IMU sample outside supported range');
}

/** Host adapter. All attitude, bias, covariance and fusion calculations run in
 * pinned PX4 C++; this class owns clocks, capability checks and UI diagnostics. */
export class Ahrs {
  private pointer = 0;
  private readonly ground = new GroundState();
  private readonly config;
  private last: number | null = null;
  private hz = 0;
  private load = 0;
  private interruption: string | null = null;
  private heading: Attitude['headingReference'] = 'relative';
  private manualHeading: number | null = null;
  private gps: GpsFix | null = null;
  private gpsTime = -Infinity;
  private stale = 0;
  private magneticSource: MagneticSample['source'] | null = null;
  private magneticIssue = 'Waiting for raw magnetic field readings';
  private tilt = stats();
  private velocity = stats();
  private altitude = stats();
  private magnetic = stats();
  private bias: Vec3 = [0, 0, 0];
  private biasStd: number;
  private initialPose: Quaternion | undefined;

  constructor(options: AhrsOptions = {}, private readonly onObservation?: ObservationListener) {
    this.config = { ...DEFAULTS, ...options };
    for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
      const value = this.config[key];
      if (typeof DEFAULTS[key] === 'boolean' ? typeof value !== 'boolean'
        : typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new RangeError(`Invalid ${key}`);
    }
    if (this.config.maxGap > .5) throw new RangeError('IMU gap too large');
    this.biasStd = this.config.initialGyroBiasStd;
    this.allocate();
  }

  private allocate(pose?: Quaternion, tiltStd = this.config.initialTiltStd): void {
    this.initialPose = pose;
    this.ground.reset();
    this.gpsTime = -Infinity;
    this.dispose();
    this.pointer = native._px4_create();
    if (!this.pointer) throw new Error('Unable to allocate PX4 EKF');
    cleanup.register(this, this.pointer, this);
    const c = this.config;
    native._px4_configure(this.pointer, +c.gpsAiding, +c.gravityAiding, c.gyroNoise, c.accelNoise,
      c.gyroBiasWalk, c.accelBiasWalk, tiltStd * RAD, c.initialAccelBiasStd);
    native._px4_seed(this.pointer, ...this.bias, this.biasStd, +!!pose, ...(pose ?? [1, 0, 0, 0]));
  }

  dispose(): void {
    if (this.pointer) { cleanup.unregister(this); native._px4_destroy(this.pointer); this.pointer = 0; }
  }

  private get handle(): number {
    if (!this.pointer) throw new Error('PX4 estimator is disposed');
    return this.pointer;
  }

  reset(): void {
    const previous = this.snapshot();
    if (previous[S.STARTED]) {
      this.bias = vector(previous, S.GYRO_BIAS);
      this.biasStd = Math.max(...sigmas(previous, S.GYRO_BIAS_VARIANCE));
    }
    this.last = null; this.hz = 0; this.load = 0; this.interruption = null;
    this.heading = 'relative'; this.manualHeading = null;
    this.gps = null; this.stale = 0;
    this.tilt = stats(); this.velocity = stats(); this.altitude = stats(); this.magnetic = stats();
    this.magneticSource = null; this.magneticIssue = 'Waiting for raw magnetic field readings';
    this.allocate();
  }

  setGyroBias(bias: Vec3, std = .05 * RAD): void {
    if (!finiteVector(bias) || norm(bias) > .2 || !Number.isFinite(std) || std <= 0) throw new RangeError('Invalid gyro bias');
    this.bias = [...bias]; this.biasStd = std;
    native._px4_seed(this.handle, ...bias, std, +!!this.initialPose, ...(this.initialPose ?? [1, 0, 0, 0]));
  }

  /** A confirmed calibration supplies the trimmed level prior. This avoids
   * choosing the first vibrating instantaneous force vector as a level datum. */
  setInitialAttitude(pose: Quaternion): void {
    if (this.last !== null || pose.length !== 4 || !pose.every(Number.isFinite) || Math.abs(Math.hypot(...pose) - 1) > 1e-6) throw new RangeError('Invalid initial attitude');
    this.initialPose = [...pose];
    native._px4_seed(this.handle, ...this.bias, this.biasStd, 1, ...pose);
  }

  alignHeading(degrees: number): void {
    if (!Number.isFinite(degrees)) throw new RangeError('Invalid heading');
    const s = this.snapshot();
    if (Math.abs(Math.cos(toEuler(quaternion(s)).pitch)) < .1) throw new RangeError('Heading is ill-conditioned near vertical pitch');
    this.manualHeading = wrap(degrees);
    this.heading = 'manual-true';
    if (s[S.STARTED]) native._px4_heading(this.handle, this.manualHeading * RAD, (this.config.initialHeadingStd * RAD) ** 2);
  }

  update(sample: ImuSample): Attitude {
    validateImuSample(sample);
    if (this.last !== null && sample.time <= this.last) return this.getState(this.last);
    const dt = this.last === null ? 0 : sample.time - this.last;
    let before = this.snapshot();
    if (dt > this.config.maxGap && before[S.STARTED]) {
      if (this.config.recoverAfterGap) {
        const previous = before;
        this.bias = vector(previous, S.GYRO_BIAS);
        this.biasStd = Math.max(...vector(previous, S.GYRO_BIAS_VARIANCE).map(sigma));
        const q = quaternion(previous);
        this.gps = null; this.hz = 0;
        this.manualHeading = null;
        this.tilt = stats(); this.velocity = stats(); this.altitude = stats(); this.magnetic = stats();
        this.allocate(q, Math.max(this.config.initialTiltStd, sigma(previous[S.ATTITUDE_COVARIANCE]! + previous[S.ATTITUDE_COVARIANCE + 4]!) / RAD, Math.min(90, 30 * dt)));
        native._px4_accel_bias(this.handle, ...vector(previous, S.ACCEL_BIAS), Math.max(...sigmas(previous, S.ACCEL_BIAS_VARIANCE)));
        before = this.snapshot();
      } else this.interruption = `Motion sample gap ${Math.round(dt * 1000)} ms`;
    }
    this.last = sample.time;
    this.load = norm(sample.specificForce) / G;
    if (!this.interruption) {
      const ground = this.ground.update(sample, vector(before, S.GYRO_BIAS));
      native._px4_ground(this.handle, sample.time, +ground.atRest, +ground.inAir);
      native._px4_imu(this.handle, sample.time, ...sample.gyro, ...sample.specificForce);
      let s = this.snapshot();
      if (!before[S.STARTED] && s[S.STARTED] && this.manualHeading !== null) {
        native._px4_heading(this.handle, this.manualHeading * RAD, (this.config.initialHeadingStd * RAD) ** 2);
        s = this.snapshot();
      }
      if (dt > 0 && dt <= this.config.maxGap) this.hz = this.hz ? .98 * this.hz + .02 / dt : 1 / dt;
      if (![...s.subarray(0, S.STARTED)].every(Number.isFinite)) this.interruption = 'Non-finite PX4 state';
      if (s[S.HEADING_SOURCE] === H.GNSS) this.heading = 'gps-inertial';
      this.observe(s, S.GRAVITY_AID, 3, 'tilt', this.tilt, .25);
      this.observe(s, S.VELOCITY_AID, s[S.VELOCITY_DIMENSION]!, 'velocity', this.velocity, 5);
      this.observe(s, S.MAGNETIC_AID, 3, 'magnetic', this.magnetic, 3);
      if (s[S.HEIGHT_VALID]) this.observe(s, S.HEIGHT_AID, 1, 'altitude', this.altitude, 5);
    }
    return this.getState(sample.time);
  }

  updateGps(fix: GpsFix): void {
    if (!Number.isFinite(fix.time) || !Number.isFinite(fix.accuracy) || fix.accuracy < 0) throw new RangeError('Invalid GPS fix');
    const handle = this.handle;
    if (!this.config.gpsAiding) return;
    if (fix.time <= this.gpsTime) { this.stale++; return; }
    this.gpsTime = fix.time;
    this.ground.observeGps(fix);
    if (this.last !== null && fix.time < this.snapshot()[S.DELAYED_TIME]!) { this.stale++; return; }
    const quality = !fix.estimated && fix.accuracy <= 50;
    const measured = fix.velocityNed && finiteVector(fix.velocityNed) ? fix.velocityNed : null;
    const horizontal = !!measured || fix.speed !== null && Number.isFinite(fix.speed) && fix.speed >= 0 &&
      (fix.speed === 0 || fix.track !== null && Number.isFinite(fix.track));
    const track = (Number.isFinite(fix.track) ? fix.track! : 0) * RAD;
    const velocity: Vec3 = measured ?? [horizontal ? fix.speed! * Math.cos(track) : 0, horizontal ? fix.speed! * Math.sin(track) : 0, 0];
    const coordinates = fix.coordinates;
    const position = !!coordinates && coordinates.every(Number.isFinite) && Math.abs(coordinates[0]) <= 180 && Math.abs(coordinates[1]) <= 90;
    const height = fix.altitude !== null && Number.isFinite(fix.altitude) && fix.altitudeAccuracy !== null &&
      Number.isFinite(fix.altitudeAccuracy) && fix.altitudeAccuracy > 0;
    // One conservative scalar noise matches PX4's GNSS receiver interface.
    const noise = fix.velocityStd && finiteVector(fix.velocityStd) && fix.velocityStd.every(v => v > 0)
      ? Math.max(...fix.velocityStd) : this.config.gpsVelocityStd;
    this.gps = quality ? structuredClone(fix) : null;
    native._px4_gps(handle, fix.time, position ? coordinates![1] : 0, position ? coordinates![0] : 0,
      height ? fix.altitude! : 0, fix.accuracy / 1.96, height ? fix.altitudeAccuracy! / 1.96 : 0,
      ...velocity, noise, +horizontal, +!!measured, +position, +height, +quality);
  }

  /** A source failure has a receipt timestamp, but no invented GPS measurement. */
  gpsUnavailable(time: number): void {
    if (!Number.isFinite(time)) throw new RangeError('Invalid GPS timestamp');
    const handle = this.handle;
    if (!this.config.gpsAiding || time <= this.gpsTime) return;
    this.gpsTime = time; this.gps = null;
    this.ground.invalidate(time);
    native._px4_gps(handle, time, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }

  updateMagnetic(sample: MagneticSample): void {
    this.magneticSource = sample.source;
    if (sample.source !== 'magnetometer') {
      this.magneticIssue = 'OS-fused compass is not a raw PX4 magnetometer input';
      return;
    }
    if (!Number.isFinite(sample.time) || !finiteVector(sample.vector)) throw new RangeError('Invalid magnetic reading');
    this.magneticIssue = '';
    native._px4_mag(this.handle, sample.time, ...sample.vector);
  }

  magneticUnavailable(reason: string): void { this.magneticIssue = reason; }

  private snapshot(): Float64Array {
    const offset = native._px4_state(this.handle) / 8;
    return native.HEAPF64.slice(offset, offset + S.SIZE);
  }

  getCovariance(): Float64Array {
    const offset = native._px4_covariance(this.handle) / 8;
    return native.HEAPF64.slice(offset, offset + N * N);
  }

  private observe(s: Float64Array, offset: number, dimension: number, source: Observation['source'], target: Stats, gate: number): void {
    const time = s[offset + A.TIME]!;
    if (!dimension || !Number.isFinite(time) || time <= target.lastAttempt) return;
    target.lastAttempt = time; target.lastFusion = s[offset + A.LAST_FUSION]!;
    const residual = [...s.slice(offset + A.INNOVATION, offset + A.INNOVATION + dimension)];
    const variance = [...s.slice(offset + A.VARIANCE, offset + A.VARIANCE + dimension)];
    const nis = residual.reduce((sum, value, i) => sum + value * value / variance[i]!, 0);
    target.nis = Number.isFinite(nis) ? nis : null;
    const result = s[offset + A.FUSED] ? 'accepted' : s[offset + A.REJECTED] ? 'innovation' : 'uninformative';
    target.lastAccepted = result === 'accepted';
    if (result === 'accepted') target.accepted++;
    else if (result === 'innovation') target.rejected++;
    target.reason = result === 'accepted' ? 'PX4 observation fused' : result === 'innovation' ? 'PX4 innovation gate' : 'PX4 fusion conditions not met';
    const covariance = Array.from({ length: dimension * dimension }, (_, i) => i % (dimension + 1) === 0 ? variance[i / (dimension + 1)]! : 0);
    this.onObservation?.({ source, time, dimension, residual, covariance, covarianceKind: 'sequential-diagonal',
      gateKind: 'per-axis-sigma', nis: target.nis, gate, result, replayed: false });
  }

  getState(now: number): Attitude {
    if (!Number.isFinite(now)) throw new RangeError('Invalid state timestamp');
    const s = this.snapshot(), q = quaternion(s), e = toEuler(q);
    const age = this.last === null ? Infinity : Math.max(0, now - this.last);
    const tiltStd = sigma(.5 * (s[S.ATTITUDE_COVARIANCE]! + s[S.ATTITUDE_COVARIANCE + 4]! + Math.hypot(s[S.ATTITUDE_COVARIANCE]! - s[S.ATTITUDE_COVARIANCE + 4]!, 2 * s[S.ATTITUDE_COVARIANCE + 1]!))) / RAD;
    const angularStd = (h: Vec3) => {
      let variance = 0;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) variance += h[r]! * s[S.ATTITUDE_COVARIANCE + r * 3 + c]! * h[c]!;
      return sigma(variance) / RAD;
    };
    const cy = Math.cos(e.yaw), sy = Math.sin(e.yaw), cp = Math.cos(e.pitch), tp = Math.tan(e.pitch);
    const rollStd = Math.abs(cp) < .1 ? Infinity : angularStd([cy / cp, sy / cp, 0]);
    const pitchStd = angularStd([-sy, cy, 0]);
    const yawStd = Math.abs(cp) < .1 ? Infinity : angularStd([cy * tp, sy * tp, 1]);
    const aligned = !!s[S.YAW_ALIGNED] && s[S.HEADING_SOURCE] !== H.UNKNOWN && yawStd <= 30;
    const atRest = !!s[S.AT_REST];
    const tiltAided = this.tilt.lastAccepted && now - this.tilt.lastFusion < 1 && !!s[S.GRAVITY];
    const gpsAided = this.velocity.lastAccepted && now - this.velocity.lastFusion < 3 && !!s[S.GNSS_VELOCITY];
    const magAided = !this.magneticIssue && this.magnetic.lastAccepted && now - this.magnetic.lastFusion < 1.5 && !!s[S.MAGNETIC_MODE];
    const status: Attitude['status'] = this.interruption ? 'interrupted' : !s[S.STARTED] ? 'waiting'
      : age > .5 ? 'stale' : tiltStd > this.config.maxTiltStd ? 'degraded'
      : tiltAided || gpsAided || magAided || atRest ? 'tracking' : 'coasting';
    const active = status === 'tracking' || status === 'degraded';
    return {
      quaternion: q, roll: e.roll / RAD, pitch: e.pitch / RAD, yaw: wrap(e.yaw / RAD),
      unaidedYaw: s[S.UNAIDED_YAW]! / RAD,
      headingReference: this.heading, headingStatus: aligned ? 'tracking' : this.heading === 'relative' ? 'acquiring' : 'recovering',
      headingReason: aligned ? this.heading === 'manual-true' ? 'Initial true heading supplied' : 'PX4 GNSS/inertial yaw alignment'
        : yawStd > 30 ? 'Heading uncertainty needs independent aiding' : 'Waiting for informative GPS motion',
      status, reason: this.interruption ?? (status === 'waiting' ? 'Hold steady to initialize' : status === 'stale' ? 'Motion samples stopped'
        : status === 'degraded' ? 'High estimated tilt uncertainty'
        : atRest ? 'Stationary bias correction' : tiltAided ? 'PX4 gravity aiding' : gpsAided ? 'PX4 GNSS aiding'
        : magAided ? 'PX4 magnetic aiding' : 'Inertial attitude; waiting for aiding'),
      groundState: s[S.IN_AIR] ? 'unknown' : atRest ? 'at-rest' : 'landed',
      groundDiagnostics: this.ground.getDiagnostics(),
      age, rate: this.hz, load: this.load, bias: vector(s, S.GYRO_BIAS), accelBias: vector(s, S.ACCEL_BIAS), velocity: vector(s, S.VELOCITY),
      attitudeStd: [rollStd, pitchStd, aligned ? yawStd : Infinity],
      tiltStd, relativeYawStd: yawStd, gyroBiasStd: sigmas(s, S.GYRO_BIAS_VARIANCE), accelBiasStd: sigmas(s, S.ACCEL_BIAS_VARIANCE),
      gravityCorrection: active && tiltAided, tiltAiding: active && tiltAided,
      magneticFusion: { mode: magAided ? s[S.MAGNETIC_MODE] === 2 ? 'vector' : 'heading' : this.magnetic.rejected ? 'rejected' : 'qualifying',
        active: active && magAided, source: this.magneticSource, reason: this.magneticIssue || this.magnetic.reason,
        accepted: this.magnetic.accepted, rejected: this.magnetic.rejected, age: Math.max(0, now - this.magnetic.lastFusion) },
      gpsAiding: active && gpsAided, gps: this.gps ? structuredClone(this.gps) : null,
      gpsAge: this.gps ? Math.max(0, now - this.gps.time) : Infinity, fusionAge: Math.max(0, now - this.velocity.lastFusion),
      tiltFusion: { ...this.tilt, source: 'imu', age: Math.max(0, now - this.tilt.lastFusion) },
      verticalSpeed: s[S.GNSS_HEIGHT] && now - this.altitude.lastFusion < 3 ? -s[S.VELOCITY + 2]! : null,
      fusion: { ...this.velocity, stale: this.stale }, altitudeFusion: { ...this.altitude },
    };
  }
}
