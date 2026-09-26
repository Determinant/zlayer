import {
  G,
  RAD,
  add,
  finiteVector,
  fromEuler,
  norm,
  scale,
  sub,
  toEuler,
  unit,
  wrap,
} from "./math.js";
import type { Vec3 } from "./math.js";
import {
  N,
  MAX_ATTITUDE_CORRECTION,
  angleStd,
  cloneState,
  fuseGps,
  numericallyHealthy,
  initialState,
  predictInterval,
  releaseHeadingCovariance,
  restartNavigation,
  tiltStd,
  transferAlignmentCovariance,
} from "./eskf.js";
import type { NavState } from "./eskf.js";
import type { AhrsOptions, Attitude, GpsFix, ImuSample, MagneticSample, Observation, ObservationListener } from "./types.js";
import { HeadingTrajectory } from "./heading-trajectory.js";
import { fuseGravity, type GravityObservation } from "./gravity-aiding.js";
import { fuseMagnetic } from "./magnetic-fusion.js";
import { fuseVelocityChange } from './velocity-change.js';
import { ageUnobservedState, predictKinematics } from './kinematics.js';
import { ImuNoise } from './imu-noise.js';
export type { AhrsOptions, Attitude, GpsFix, ImuSample } from "./types.js";

export const DEFAULTS: Required<AhrsOptions> = Object.freeze({
  gpsAiding: true,
  gravityAiding: true,
  maxGap: 0.25,
  recoverAfterGap: false,
  historySeconds: 3,
  gyroNoise: 0.05 * RAD,
  accelNoise: 0.15,
  gyroBiasWalk: 0.003 * RAD,
  accelBiasWalk: 0.01,
  accelerationWalk: .6,
  persistentAccelerationWalk: .03,
  accelerationTimeConstant: 5,
  initialAccelerationStd: 1.5,
  initialGyroBiasStd: 0.5 * RAD,
  initialAccelBiasStd: 0.2,
  initialTiltStd: 3,
  initialHeadingStd: 10,
  gpsVelocityStd: 1.5,
  maxTiltStd: 10,
});
type Event = { kind: "imu"; value: ImuSample } | { kind: "gps"; value: GpsFix; northAligned: boolean } | { kind: "tilt"; value: GravityObservation }
  | { kind: 'magnetic'; value: MagneticSample };
interface Checkpoint {
  state: NavState;
  sample: ImuSample;
  time: number;
}
interface Entry {
  event: Event;
  after: Checkpoint;
}
const eventOrder = { imu: 0, tilt: 1, gps: 2, magnetic: 3 };
const MAX_NAVIGATION_SPEED = 2000; // m/s; bounds the trajectory, not live attitude
const compare = (a: Event, b: Event) => a.value.time - b.value.time || eventOrder[a.kind] - eventOrder[b.kind];
const copySample = (s: ImuSample): ImuSample => ({
  time: s.time,
  gyro: [...s.gyro],
  specificForce: [...s.specificForce],
});
const copyGps = (f: GpsFix): GpsFix => ({
  ...f,
  ...(f.velocityNed ? { velocityNed: [...f.velocityNed] as Vec3 } : {}),
  ...(f.velocityStd ? { velocityStd: [...f.velocityStd] as Vec3 } : {}),
});

/** Shared input check: hosts may skip an unusable reading before updating state. */
export function validateImuSample({ time, gyro, specificForce }: ImuSample): void {
  if (!Number.isFinite(time) || !finiteVector(gyro) || !finiteVector(specificForce))
    throw new TypeError("IMU samples must be finite");
  if (norm(gyro) > 35 || norm(specificForce) > 20 * G)
    throw new RangeError("IMU sample outside supported range");
}

/** Joint inertial, gravity/acceleration and relative magnetic ESKF.
 * GPS supplies navigation aiding and, with excitation, north alignment. Raw
 * magnetic vectors can correct all observable attitude/bias directions; browser
 * compass fallbacks only aid heading. See ../README.md for model limitations.
 */
export class Ahrs {
  private readonly config: Required<AhrsOptions>;
  private state: NavState;
  private biasStd: number;
  private heading: Attitude["headingReference"] = "relative";
  private headingStatus: Attitude["headingStatus"] = "acquiring";
  private headingReason = "Waiting for informative GPS motion";
  private readonly headingTrajectory: HeadingTrajectory;
  private magneticIssue: string | null = null;
  private pendingMagnetic: MagneticSample[] = [];
  private initialized = false;
  private interruption: string | null = null;
  private last: number | null = null;
  private current: Checkpoint | null = null;
  private base: Checkpoint | null = null;
  private history: Entry[] = [];
  private pending: GpsFix[] = [];
  private gps: GpsFix | null = null;
  private stale = 0;
  private hz = 0;
  private load = 0;
  private readonly imuNoise = new ImuNoise();

  constructor(options: AhrsOptions = {}, private readonly onObservation?: ObservationListener) {
    this.config = { ...DEFAULTS, ...options };
    for (const [key, value] of Object.entries(this.config)) {
      if (key === "gpsAiding" || key === "gravityAiding" || key === "recoverAfterGap") {
        if (typeof value !== "boolean")
          throw new RangeError(`Invalid ${key}`);
      } else if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0
      )
        throw new RangeError(`Invalid ${key}`);
    }
    if (this.config.historySeconds > 10 || this.config.maxGap > 0.5)
      throw new RangeError("History or IMU gap too large");
    if (this.config.accelerationTimeConstant < .1 || this.config.accelerationTimeConstant > 60)
      throw new RangeError('Acceleration time constant must be between 0.1 and 60 seconds');
    this.headingTrajectory = new HeadingTrajectory(this.config);
    this.biasStd = this.config.initialGyroBiasStd;
    this.state = initialState(
      [1, 0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      false,
      this.config,
    );
  }

  reset(): void {
    this.imuNoise.reset();
    const bias = this.state.bg;
    this.headingTrajectory.reset();
    this.magneticIssue = null;
    this.pendingMagnetic = [];
    this.heading = "relative";
    this.headingStatus = "acquiring";
    this.headingReason = "Waiting for informative GPS motion";
    this.initialized = false;
    this.interruption = null;
    this.last = null;
    this.current = null;
    this.base = null;
    this.history = [];
    this.pending = [];
    this.gps = null;
    this.hz = 0;
    this.load = 0;
    this.stale = 0;
    this.biasStd = this.config.initialGyroBiasStd;
    this.state = initialState(
      [1, 0, 0, 0],
      bias,
      [0, 0, 0],
      false,
      this.config,
    );
  }

  /** Explicit stationary calibration result, radians/second in body axes.
   * std is the uncertainty of that calibration, not the raw sample noise.
   */
  setGyroBias(bias: Vec3, std = 0.05 * RAD): void {
    if (
      !finiteVector(bias) ||
      norm(bias) > 0.2 ||
      !Number.isFinite(std) ||
      std <= 0
    )
      throw new RangeError("Invalid gyro bias");
    this.state.bg = [...bias];
    this.biasStd = std;
    for (let i = 12; i < 15; i++) {
      for (let j = 0; j < N; j++)
        this.state.P[i * N + j] = this.state.P[j * N + i] = 0;
      this.state.P[i * N + i] = std ** 2;
    }
    this.flushHistory();
  }

  /** Initial TRUE heading, never ground track. Resets the navigation alignment.
   * Subsequent yaw corrections require informative GNSS-aided motion.
   */
  alignHeading(degrees: number): void {
    this.align(degrees, "manual-true", this.config.initialHeadingStd);
  }

  private align(degrees: number, reference: Exclude<Attitude["headingReference"], "relative">, std: number): void {
    if (!Number.isFinite(degrees)) throw new RangeError("Invalid heading");
    const e = toEuler(this.state.q);
    if (Math.abs(Math.cos(e.pitch)) < 0.1)
      throw new RangeError(
        "Heading is ill-conditioned near vertical pitch — level before aligning",
      );
    const next = restartNavigation(this.state, fromEuler(e.roll, e.pitch, wrap(degrees) * RAD), this.config);
    transferAlignmentCovariance(this.state, next, std, reference === 'gps-inertial');
    this.heading = reference;
    this.headingStatus = "tracking";
    this.headingReason = reference === "manual-true" ? "Initial true heading supplied" : "Aligned by GPS and IMU motion";
    this.state = next;
    this.flushHistory();
  }

  /** A local Gaussian tracker cannot represent a broad absolute-yaw prior.
   * Release that reference while retaining tilt/bias information, then use the
   * same global motion fit as startup. Source history never implies validity.
   * A single innovation outlier is rejected normally; only an unsupported
   * attitude correction or excessive uncertainty releases the alignment. */
  private reviewHeading(): void {
    if (this.headingStatus !== "tracking" || this.interruption !== null) return;
    const reason = angleStd(this.state)[2] * RAD > MAX_ATTITUDE_CORRECTION
      ? "Heading uncertainty exceeds tracking range"
      : this.state.velocityCorrection === "attitude-limit"
        ? "GPS attitude correction exceeds tracking range" : null;
    if (!reason) return;
    const next = restartNavigation(this.state, this.state.q, this.config);
    releaseHeadingCovariance(this.state, next);
    this.state = next;
    this.headingStatus = "recovering";
    this.headingReason = reason;
    // Start at the current IMU time: no old GPS fix or corrected navigation
    // velocity may supply evidence for the replacement alignment.
    this.flushHistory();
  }

  private checkpoint(): Checkpoint {
    return {
      state: cloneState(this.state),
      sample: this.current!.sample,
      time: this.current!.time,
    };
  }
  private flushHistory(): void {
    this.resetHeadingTrajectory();
    this.history = [];
    this.pending = [];
    this.pendingMagnetic = [];
    if (this.current) {
      this.current.state = this.state;
      this.base = this.checkpoint();
    }
  }
  private resetHeadingTrajectory(): void {
    this.headingTrajectory.reset(this.state, this.current?.sample);
  }
  private apply(event: Event, replayed = false): void {
    const current = this.current!;
    // The explicit gravity-disabled option retains conventional strapdown INS:
    // force is then a process input and is never fused as a second observation.
    const propagate = this.config.gravityAiding ? predictKinematics : predictInterval;
    propagate(this.state, current.sample, event.value.time - current.time, this.config);
    current.time = event.value.time;
    const publish = this.onObservation ? (observation: Observation) => this.onObservation!({ ...observation, replayed }) : undefined;
    if (event.kind === "imu") current.sample = event.value;
    else if (event.kind === "tilt") fuseGravity(this.state, event.value, this.config, publish);
    else if (event.kind === 'magnetic') fuseMagnetic(this.state, event.value, this.config, publish);
    else {
      fuseGps(this.state, event.value, this.config, publish, event.northAligned);
      if (!event.northAligned) fuseVelocityChange(this.state, event.value, this.config, publish);
    }
    current.state = this.state;
  }
  private insert(event: Event): void {
    if (
      !this.base ||
      event.value.time < this.base.time ||
      (event.kind === "gps" && event.value.time <= this.base.state.lastGpsTime)
    ) {
      this.stale++;
      return;
    }
    let index = this.history.length;
    while (index > 0 && compare(this.history[index - 1]!.event, event) > 0)
      index--;
    if (
      event.kind === "gps" &&
      this.history.some(
        (e) =>
          e.event.kind === "gps" && e.event.value.time === event.value.time,
      )
    )
      return;
    if (index < this.history.length) {
      const before = index === 0 ? this.base : this.history[index - 1]!.after;
      this.state = cloneState(before.state);
      this.current = {
        state: this.state,
        sample: before.sample,
        time: before.time,
      };
      const replay = [event, ...this.history.slice(index).map((e) => e.event)];
      this.history.length = index;
      for (const item of replay) {
        this.apply(item, item !== event);
        this.history.push({ event: item, after: this.checkpoint() });
      }
    } else {
      this.apply(event);
      this.history.push({ event, after: this.checkpoint() });
    }
    if (!numericallyHealthy(this.state)) {
      this.interruption ??= "Estimator health check failed";
    } else if (norm(this.state.v) >= MAX_NAVIGATION_SPEED) {
      // An unobserved translation can drift outside the navigation model while
      // the IMU still supports relative attitude. Discard only that trajectory
      // and its correlations; retain the full attitude/bias marginal, including
      // its growing uncertainty. Fresh GPS must initialize navigation again.
      this.state = restartNavigation(this.state, this.state.q, this.config);
      this.state.reason = "Navigation drift exceeded the supported velocity range";
      this.flushHistory();
    }
    const cutoff = this.current!.time - this.config.historySeconds;
    let remove = 0;
    while (
      remove < this.history.length &&
      (this.history[remove]!.event.value.time < cutoff ||
        this.history.length - remove > 3000)
    )
      remove++;
    if (remove) {
      this.base = this.history[remove - 1]!.after;
      this.history.splice(0, remove);
    }
  }

  updateGps(fix: GpsFix): void {
    if (
      !Number.isFinite(fix.time) ||
      !Number.isFinite(fix.accuracy) ||
      fix.accuracy < 0
    )
      return;
    if (
      fix.velocityNed &&
      (!finiteVector(fix.velocityNed) || norm(fix.velocityNed) > 1000)
    )
      return;
    if (
      fix.velocityStd &&
      (!finiteVector(fix.velocityStd) || fix.velocityStd.some((x) => x <= 0))
    )
      return;
    const clean = copyGps({
      ...fix,
      speed:
        fix.speed !== null &&
        Number.isFinite(fix.speed) &&
        fix.speed >= 0 &&
        fix.speed <= 1000
          ? fix.speed
          : null,
      track:
        fix.track !== null && Number.isFinite(fix.track)
          ? wrap(fix.track)
          : null,
      altitude:
        fix.altitude !== null && Number.isFinite(fix.altitude)
          ? fix.altitude
          : null,
      altitudeAccuracy:
        fix.altitudeAccuracy !== null &&
        Number.isFinite(fix.altitudeAccuracy) &&
        fix.altitudeAccuracy >= 0
          ? fix.altitudeAccuracy
          : null,
    });
    if (this.current && clean.time > this.current.time + .5) { this.stale++; return; }
    if (!this.gps || clean.time > this.gps.time) this.gps = clean;
    if (
      !this.config.gpsAiding ||
      this.interruption !== null
    )
      return;
    if (clean.accuracy > 50 || clean.estimated) {
      this.stale++;
      this.resetHeadingTrajectory();
      return;
    }
    if (!this.current || clean.time > this.current.time) {
      if (!this.pending.some((f) => f.time === clean.time))
        this.pending.push(clean);
      this.pending.sort((a, b) => a.time - b.time);
      if (this.pending.length > 32) {
        this.pending.pop();
        this.stale++;
      }
    } else this.observeGps(clean);
  }

  /** Optional relative magnetic aid. It cannot initialize or change north alignment. */
  updateMagnetic(sample: MagneticSample): void {
    if (!this.current || this.interruption || !Number.isFinite(sample.time)) return;
    if (sample.source === 'webkit-compass' ? !finiteVector(sample.axis)
      : !['magnetometer', 'absolute-orientation'].includes(sample.source) || !finiteVector(sample.vector)) {
      this.magneticUnavailable('Invalid magnetic reading'); return;
    }
    if (sample.time > this.current.time + .5 || sample.time < this.current.time - this.config.historySeconds) return;
    this.magneticIssue = null;
    const clean: MagneticSample = sample.source === 'webkit-compass' ? { ...sample, axis: [...sample.axis] }
      : { ...sample, vector: [...sample.vector] };
    if (clean.time > this.current.time) {
      if (!this.pendingMagnetic.some(item => item.time === clean.time)) this.pendingMagnetic.push(clean);
      this.pendingMagnetic.sort((a, b) => a.time - b.time);
      if (this.pendingMagnetic.length > 16) this.pendingMagnetic.pop();
    } else this.observeMagnetic(clean);
  }

  magneticUnavailable(reason: string): void {
    this.magneticIssue = reason;
    this.pendingMagnetic = [];
  }

  private observeMagnetic(sample: MagneticSample): void {
    if (!this.base || sample.time < this.base.time) return;
    if (sample.time <= this.base.state.magnetic.lastSample || this.history.some(entry =>
      entry.event.kind === 'magnetic' && entry.event.value.time === sample.time)) return;
    this.insert({ kind: 'magnetic', value: sample });
  }

  private observeGps(fix: GpsFix): void {
    if (!this.base || fix.time < this.base.time) { this.stale++; return; }
    if (this.headingStatus === "tracking") {
      const accepted = this.state.accepted;
      this.insert({ kind: "gps", value: fix, northAligned: true });
      this.reviewHeading();
      if (this.headingStatus === "tracking") {
        // Only fresh rejected velocity observations can supply replacement
        // alignment evidence. Altitude fusion cannot alter the independent
        // trajectory or consume its horizontal GPS observations.
        if (this.state.accepted !== accepted || this.state.lastGpsTime !== fix.time ||
          this.state.velocityCorrection === null || this.state.velocityCorrection === "accepted") this.resetHeadingTrajectory();
        else this.observeHeading(fix);
      }
      return;
    }
    this.insert({ kind: "gps", value: fix, northAligned: false });
    this.observeHeading(fix);
  }

  private observeHeading(fix: GpsFix): void {
    const alignment = this.headingTrajectory.observe(fix);
    const attitude = toEuler(this.state.q);
    // Automatic alignment must wait through the Euler heading singularity.
    if (alignment && Math.abs(Math.cos(attitude.pitch)) >= .1) {
      this.align(alignment.headingDegrees, "gps-inertial", alignment.headingStdDegrees);
      // Only subsequent fixes enter the freshly aligned navigation filter, so
      // the observations used for coarse heading are not fused a second time.
    }
  }

  update(sample: ImuSample): Attitude {
    validateImuSample(sample);
    const { time, specificForce } = sample;
    if (this.last !== null && time <= this.last)
      return this.getState(this.last);
    const dt = this.last === null ? 0 : time - this.last;
    this.last = time;
    this.load = norm(specificForce) / G;
    if (dt > this.config.maxGap && this.config.recoverAfterGap && this.initialized && this.interruption === null) {
      this.imuNoise.reset();
      this.imuNoise.observe(sample);
      // No extrapolation across missing measurements. Keep the last pose and
      // calibrated biases, but discard navigation/history spanning the gap.
      this.state = restartNavigation(this.state, this.state.q, this.config);
      ageUnobservedState(this.state, dt, this.config);
      // Engineering allowance for unobserved rotation, not a measured maneuver.
      const variance = (Math.min(90, 30 * dt) * RAD) ** 2;
      for (let i = 6; i < 9; i++) this.state.P[i * N + i]! += variance;
      this.state.lastVelocityFusion = -Infinity;
      this.state.tilt.lastFusion = -Infinity;
      this.state.magnetic.lastFusion = -Infinity;
      this.state.reacquiring = true;
      this.state.tilt.quietSince = Infinity;
      this.state.magnetic.healthySince = Infinity;
      this.state.magnetic.mode = 'qualifying';
      this.state.magnetic.reacquiring = true;
      this.gps = null;
      this.hz = 0;
      if (this.headingStatus === "tracking") this.headingStatus = "recovering";
      this.headingReason = "Motion gap; waiting for fresh heading evidence";
      this.current = { state: this.state, sample: copySample(sample), time };
      this.flushHistory();
      return this.getState(time);
    }
    if (dt > this.config.maxGap)
      this.interruption ??= `Motion sample gap ${Math.round(dt * 1000)} ms`;
    if (this.interruption !== null) return this.getState(time);
    const noise = this.imuNoise.observe(sample);
    if (!this.initialized) {
      if (Math.abs(this.load - 1) > 0.12) return this.getState(time);
      // This requires a stationary start; a single accelerometer cannot prove rest.
      const d = scale(unit(specificForce), -1);
      const q = fromEuler(
        Math.atan2(d[1], d[2]),
        Math.atan2(-d[0], Math.hypot(d[1], d[2])),
        toEuler(this.state.q).yaw,
      );
      this.state = initialState(
        q,
        this.state.bg,
        this.state.ba,
        this.headingStatus === "tracking",
        this.config,
        this.biasStd,
      );
      this.initialized = true;
      this.current = { state: this.state, sample: copySample(sample), time };
      this.base = this.checkpoint();
      this.resetHeadingTrajectory();
    } else {
      this.hz = this.hz ? this.hz * 0.95 + 0.05 / dt : 1 / dt;
      const reading = copySample(sample);
      this.insert({ kind: "imu", value: reading });
      this.headingTrajectory.update(reading);
    }
    // Each fresh force sample enters once as a measurement. Gyro-only process
    // propagation never consumes it, so GPS and acceleration can correct jointly.
    // Insert it before queued fixes at this time, so acceptance/alignment decisions
    // see the same ordered state that replay will reconstruct.
    if (this.config.gravityAiding && dt > 0) {
      this.insert({ kind: 'tilt', value: { time, force: [...specificForce],
        gyro: [...sample.gyro],
        steadyForce: [...noise.force], steadyGyro: [...noise.gyro],
        variance: this.config.accelNoise ** 2 / dt + .3 ** 2 + noise.variance } });
    }
    while (this.pending.length && this.pending[0]!.time <= time) {
      const fix = this.pending.shift()!;
      this.observeGps(fix);
    }
    while (this.pendingMagnetic.length && this.pendingMagnetic[0]!.time <= time)
      this.observeMagnetic(this.pendingMagnetic.shift()!);
    this.reviewHeading();
    if (this.headingTrajectory.needsRefresh(time)) this.resetHeadingTrajectory();
    return this.getState(time);
  }

  /** Row-major 30×30 covariance; order p,v,θ,ba,bg,a_persistent,m_world,b_m,a_transient,v_anchor.
   * SI units except magnetic components (fractions of the initial field norm).
   * During heading acquisition/recovery this is in an arbitrary local-level frame; it
   * does not describe the unknown absolute heading (reported as Infinity).
   */
  getCovariance(): Float64Array {
    return this.state.P.slice();
  }

  getState(now: number): Attitude {
    if (!Number.isFinite(now)) throw new RangeError("Invalid state timestamp");
    const s = this.state,
      e = toEuler(s.q),
      std = angleStd(s),
      tilt = tiltStd(s);
    const age = this.last === null ? Infinity : Math.max(0, now - this.last);
    const fusionAge = Math.max(0, now - s.lastVelocityFusion);
    const aligned = this.headingStatus === "tracking";
    const aided = fusionAge < 2.5 || now - s.lastVerticalVelocityFusion < 2.5 || now - s.lastAltitudeFusion < 2.5;
    const tiltAided = now - s.tilt.lastFusion < 1 &&
      s.tilt.lastFusion === s.tilt.lastAttempt;
    const magneticActive = !this.magneticIssue && (s.magnetic.mode === 'heading' || s.magnetic.mode === 'vector') &&
      now - s.magnetic.lastFusion < 1.5 && now >= s.magnetic.blockedUntil;
    const status: Attitude["status"] =
      this.interruption !== null
        ? "interrupted"
        : !this.initialized
          ? "waiting"
          : age > 0.5
            ? "stale"
            : tilt > this.config.maxTiltStd
              ? "degraded"
              : aided || tiltAided || magneticActive
                ? "tracking"
                : "coasting";
    const reason =
      status === "interrupted"
        ? `${this.interruption} — reset while stationary`
        : status === "waiting"
          ? "Hold stationary to initialize"
          : status === "stale"
            ? "Motion samples stopped"
            : status === "degraded"
              ? "High estimated tilt uncertainty — re-align while stationary"
              : tiltAided
                ? `Gravity/acceleration aiding${aligned ? '' : ' — heading remains unaligned'}`
                : magneticActive
                  ? s.magnetic.reason
                : !aided
                  ? !aligned
                    ? "Relative attitude — waiting for informative GPS motion"
                    : "No recent GNSS velocity — uncertainty growing"
                  : s.reason;
    const diagonal = (start: number): Vec3 => {
      const std = (i: number) => Math.sqrt(Math.max(0, s.P[i * N + i]!));
      return [std(start), std(start + 1), std(start + 2)];
    };
    return {
      quaternion: [...s.q],
      roll: e.roll / RAD,
      pitch: e.pitch / RAD,
      yaw: wrap(e.yaw / RAD),
      headingReference: this.heading,
      headingStatus: this.headingStatus,
      headingReason: this.headingReason,
      status,
      reason,
      age,
      rate: this.hz,
      load: this.load,
      bias: [...s.bg],
      accelBias: [...s.ba],
      velocity: [...s.v],
      attitudeStd: aligned ? std : [std[0], std[1], Infinity],
      tiltStd: tilt,
      relativeYawStd: std[2],
      gyroBiasStd: diagonal(12),
      accelBiasStd: diagonal(9),
      gravityCorrection: tiltAided && (status === "tracking" || status === "degraded"),
      tiltAiding: tiltAided && (status === "tracking" || status === "degraded"),
      magneticFusion: {
        mode: s.magnetic.mode,
        active: magneticActive && age <= .5 && this.interruption === null,
        source: s.magneticReference?.source ?? null,
        reason: this.magneticIssue ?? (now - Math.max(s.magnetic.lastSample, s.magnetic.candidate?.last ?? -Infinity) > 1.5 ? 'Waiting for magnetic readings' : s.magnetic.reason),
        accepted: s.magnetic.accepted, rejected: s.magnetic.rejected,
        age: Math.max(0, now - s.magnetic.lastFusion),
      },
      gpsAiding: aided && (status === "tracking" || status === "degraded"),
      gps: this.gps ? copyGps(this.gps) : null,
      gpsAge: this.gps ? Math.max(0, now - this.gps.time) : Infinity,
      fusionAge,
      tiltFusion: { ...s.tilt, age: Math.max(0, now - s.tilt.lastFusion) },
      verticalSpeed:
        Math.max(s.lastAltitudeFusion, s.lastVerticalVelocityFusion) > now - 3
          ? -s.v[2]
          : null,
      fusion: {
        accepted: s.accepted,
        rejected: s.rejected,
        stale: this.stale,
        nis: s.nis,
        reason: s.reason,
      },
      altitudeFusion: { ...s.altitude },
    };
  }
}

/** Explicit stationary calibration; cannot distinguish constant rotation from bias. */
export function estimateGyroBias(samples: readonly ImuSample[]): Vec3 {
  if (samples.length < 30 || samples.at(-1)!.time - samples[0]!.time < 2)
    throw new Error("Collect at least two seconds of stationary samples");
  if (
    samples.some(
      (s) =>
        !finiteVector(s.gyro) ||
        !finiteVector(s.specificForce) ||
        !Number.isFinite(s.time),
    )
  )
    throw new Error("Invalid calibration sample");
  if (
    samples.some(
      (s, i) =>
        i > 0 &&
        (s.time <= samples[i - 1]!.time || s.time - samples[i - 1]!.time > 0.25),
    )
  )
    throw new Error("Sampling interrupted. Retry calibration.");
  const mean = scale(
    samples.reduce<Vec3>((v, s) => add(v, s.gyro), [0, 0, 0]),
    1 / samples.length,
  );
  const spread = Math.sqrt(
    samples.reduce((v, s) => v + norm(sub(s.gyro, mean)) ** 2, 0) /
      samples.length,
  );
  const gravity = scale(
    samples.reduce<Vec3>((v, s) => add(v, s.specificForce), [0, 0, 0]),
    1 / samples.length,
  );
  if (
    norm(mean) > 3 * RAD ||
    spread > 0.18 * RAD ||
    samples.some(
      (s) =>
        Math.abs(norm(s.specificForce) / G - 1) > 0.06 ||
        norm(sub(s.specificForce, gravity)) > 0.35,
    )
  ) {
    throw new Error(
      "Movement detected. Place the phone on a stable surface and retry.",
    );
  }
  return mean;
}
