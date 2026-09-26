import {
  G,
  RAD,
  add,
  dot,
  finiteVector,
  fromEuler,
  norm,
  scale,
  sub,
  unit,
} from "./math.js";
import type { Quaternion, Vec3 } from "./math.js";
import type { ImuSample } from "./types.js";

/** Minimum movement for GPS calibration evidence and the instrument's GPS warning. */
export const MIN_FLIGHT_GPS_SPEED = 10; // m/s, about 20 kt
const TIME_EPSILON = 1e-6; // Seconds; timestamp rounding must not exclude a boundary GPS fix.
const MAX_IMU_INTERVAL = 0.25;
const STEADY_MEAN_SECONDS = 0.5;
const MAX_RESUME_TILT = 5 * RAD;

/** A missing interval contributes no calibration evidence. */
function observedInterval(first: ImuSample, next: ImuSample): number {
  const dt = next.time - first.time;
  return dt <= MAX_IMU_INTERVAL ? dt : 0;
}

/** Match the calibration window's time weighting, including its excluded gaps. */
function meanForce(samples: readonly ImuSample[]): Vec3 | null {
  let seconds = 0, sum: Vec3 = [0, 0, 0];
  for (let i = 0; i + 1 < samples.length; i++) {
    const dt = observedInterval(samples[i]!, samples[i + 1]!);
    seconds += dt;
    sum = add(sum, scale(samples[i]!.specificForce, dt));
  }
  return seconds > 0 ? scale(sum, 1 / seconds) : null;
}

/** Source-neutral GPS motion input. Time shares the IMU monotonic clock. */
export interface FlightGpsSample {
  time: number;
  speed: number | null;
  track: number | null;
  accuracy: number;
  /** True when speed/track were inferred from successive positions. */
  estimated?: boolean;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  velocityNed?: Vec3;
}

export type FlightAlignmentReason =
  | "collecting-imu"
  | "pose-changed"
  | "imu-stale"
  | "imu-unstable"
  | "collecting-gps"
  | "gps-unusable"
  | "gps-stale"
  | "gps-unstable"
  | "vertical-evidence-unavailable"
  | "vertical-motion"
  | "ready";

export interface FlightAlignmentSolution {
  /** A steady GPS velocity window corroborated the pilot's confirmation. */
  gpsVerified: boolean;
  /** Timestamp of the final IMU sample, on the shared monotonic clock. */
  time: number;
  /** Averaged body specific force, suitable for initial tilt alignment. */
  specificForce: Vec3;
  /** Mean body angular rate, usable as a tentative gyro bias. */
  gyroBias: Vec3;
  /** Conservative uncertainty for a bias estimated during flight, rad/s. */
  gyroBiasStd: number;
  /** Optional additional body-frame rotation that zeroes pitch/bank at this pose.
   * Apply to BOTH future gyro and force samples, and rotate gyroBias likewise.
   */
  levelTrim: Quaternion;
}

export interface FlightAlignmentStatus {
  reason: FlightAlignmentReason;
  /** The measured IMU check that prevents alignment; values use SI units. */
  issue: FlightAlignmentIssue | null;
  /** Observed IMU time collected, excluding pauses, seconds. */
  elapsed: number;
  requiredSeconds: number;
  /** Non-null only while all checks pass. The host decides when to apply it. */
  solution: FlightAlignmentSolution | null;
}

export interface FlightAlignmentIssue {
  kind: "force-magnitude" | "force-noise" | "force-change" | "gyro-noise" | "gyro-change" | "gyro-rate" | "angular-scatter";
  value: number;
  limit: number;
}

/** RMS angular excursion about the window's mean rate. Integrate every observed
 * interval, including its within-interval variation; rapid zero-mean rates can
 * have small displacement without representing a steadily rotating mount.
 */
function angularScatter(samples: readonly ImuSample[], weights: readonly number[], gyro: Vec3, seconds: number): number {
  let angle: Vec3 = [0, 0, 0], sum: Vec3 = [0, 0, 0], squared = 0;
  for (let i = 0; i < samples.length; i++) {
    const dt = weights[i]!, rate = sub(samples[i]!.gyro, gyro);
    sum = add(sum, add(scale(angle, dt), scale(rate, dt * dt / 2)));
    squared += dt * (dot(angle, angle) + dt * dot(angle, rate) + dt * dt / 3 * dot(rate, rate));
    angle = add(angle, scale(rate, dt));
  }
  return Math.sqrt(Math.max(0, squared / seconds - norm(scale(sum, 1 / seconds)) ** 2));
}

/** Complete half-second means, weighted by observed time, ending at the newest
 * reading. Each reading represents the interval until the next, as in propagation.
 * Keeping the newest interval prevents a recent movement from being discarded.
 */
function steadyMeans(samples: readonly ImuSample[], weights: readonly number[]): Pick<ImuSample, "gyro" | "specificForce">[] {
  const seconds = STEADY_MEAN_SECONDS;
  const means: Pick<ImuSample, "gyro" | "specificForce">[] = [];
  let remaining = seconds;
  let gyro: Vec3 = [0, 0, 0], force: Vec3 = [0, 0, 0];
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i]!;
    let available = weights[i]!;
    while (available > TIME_EPSILON) {
      const dt = Math.min(available, remaining);
      gyro = add(gyro, scale(sample.gyro, dt));
      force = add(force, scale(sample.specificForce, dt));
      available -= dt;
      remaining -= dt;
      if (remaining <= TIME_EPSILON) {
        means.push({ gyro: scale(gyro, 1 / seconds), specificForce: scale(force, 1 / seconds) });
        gyro = [0, 0, 0]; force = [0, 0, 0];
        remaining = seconds;
      }
    }
  }
  return means;
}

export interface FlightAlignmentOptions {
  /** Duration of steady flight required before proposing an alignment. Default 10 s. */
  windowSeconds?: number;
  /** Require recent GPS altitude or direct vertical velocity. Default true. */
  requireVerticalEvidence?: boolean;
  /** Accept position-derived speed/track. Default false. */
  allowEstimatedMotion?: boolean;
  /** Propose a reference attitude when GPS evidence is unavailable. Default false.
   * The solution reports whether GPS corroborated the window in gpsVerified.
   */
  allowUnaided?: boolean;
  /** Keep evidence through pauses when the resumed pose agrees; exclude missing time. Default false. */
  pauseOnGap?: boolean;
}

/** UI-free evidence gate for pilot-confirmed in-flight pitch/bank alignment.
 * It never changes an Ahrs instance and never treats GPS track as true heading.
 */
export class FlightAlignment {
  private readonly windowSeconds: number;
  private readonly requireVerticalEvidence: boolean;
  private readonly allowEstimatedMotion: boolean;
  private readonly allowUnaided: boolean;
  private readonly pauseOnGap: boolean;
  private imu: ImuSample[] = [];
  private imuSeconds = 0;
  private gps: FlightGpsSample[] = [];
  private resumedAt: number | null = null;
  private poseChanged = false;

  constructor(options: FlightAlignmentOptions = {}) {
    this.windowSeconds = options.windowSeconds ?? 10;
    this.requireVerticalEvidence = options.requireVerticalEvidence ?? true;
    this.allowEstimatedMotion = options.allowEstimatedMotion ?? false;
    this.allowUnaided = options.allowUnaided ?? false;
    this.pauseOnGap = options.pauseOnGap ?? false;
    if (!Number.isFinite(this.windowSeconds) || this.windowSeconds < 3)
      throw new RangeError("windowSeconds must be at least 3 seconds");
  }

  reset(): void {
    this.imu = [];
    this.imuSeconds = 0;
    this.gps = [];
    this.resumedAt = null;
    this.poseChanged = false;
  }

  observeImu(sample: ImuSample): void {
    if (
      !Number.isFinite(sample.time) ||
      !finiteVector(sample.gyro) ||
      !finiteVector(sample.specificForce)
    )
      throw new TypeError("Invalid IMU sample");
    const previous = this.imu.at(-1);
    if (previous && sample.time <= previous.time) return;
    if (previous) {
      const dt = observedInterval(previous, sample);
      if (dt === 0 && !this.pauseOnGap) this.reset();
      else {
        this.imuSeconds += dt;
        if (dt === 0) this.resumedAt = sample.time;
        // Consecutive isolated readings provide no evidence. Keep only the
        // newest endpoint so a long pause cannot accumulate empty intervals.
        if (dt === 0 && this.imu.length > 1 && observedInterval(this.imu.at(-2)!, previous) === 0)
          this.imu.pop();
      }
    }
    this.imu.push({
      time: sample.time,
      gyro: [...sample.gyro],
      specificForce: [...sample.specificForce],
    });
    while (this.imuSeconds > this.windowSeconds + MAX_IMU_INTERVAL && this.imu.length > 1) {
      this.imuSeconds -= observedInterval(this.imu[0]!, this.imu[1]!);
      this.imu.shift();
    }
    this.checkResumedPose();
    const cutoff = this.imu[0]!.time;
    while (this.gps.length && this.gps[0]!.time < cutoff) this.gps.shift();
  }

  private checkResumedPose(): void {
    const resumedAt = this.resumedAt, last = this.imu.at(-1)!;
    // Before proposing an alignment, require a short continuous window from the
    // latest segment. An isolated resumed reading must never finish calibration.
    if (resumedAt === null || this.imuSeconds < this.windowSeconds - MAX_IMU_INTERVAL ||
      last.time - resumedAt + TIME_EPSILON < STEADY_MEAN_SECONDS) return;
    const start = this.imu.findIndex(sample => sample.time >= resumedAt);
    const before = meanForce(this.imu.slice(0, start));
    const resumed = this.imu.slice(start), after = meanForce(resumed);
    if (before && after && dot(unit(before), unit(after)) < Math.cos(MAX_RESUME_TILT)) {
      // Rotation during a missing interval leaves no gyro evidence. Do not let
      // old readings outweigh a different, newly steady pose. Keep the fresh
      // segment so it can finish collecting without restarting the sensors.
      this.imu = resumed;
      this.imuSeconds = last.time - resumed[0]!.time;
      this.poseChanged = true;
    }
    this.resumedAt = null;
  }

  observeGps(fix: FlightGpsSample): void {
    if (!Number.isFinite(fix.time) || !Number.isFinite(fix.accuracy)) return;
    if (this.gps.some((previous) => previous.time === fix.time)) return;
    this.gps.push({
      ...fix,
      ...(fix.velocityNed ? { velocityNed: [...fix.velocityNed] as Vec3 } : {}),
    });
    this.gps.sort((a, b) => a.time - b.time);
    const cutoff =
      this.imu[0]?.time ?? fix.time - this.windowSeconds - MAX_IMU_INTERVAL;
    while (this.gps.length && this.gps[0]!.time < cutoff) this.gps.shift();
    if (this.gps.length > 512) this.gps.splice(0, this.gps.length - 512);
  }

  snapshot(now: number): FlightAlignmentStatus {
    if (!Number.isFinite(now)) throw new RangeError("Invalid timestamp");
    const last = this.imu.at(-1);
    const elapsed = this.imuSeconds;
    const result = (
      reason: FlightAlignmentReason,
      solution: FlightAlignmentSolution | null = null,
      issue: FlightAlignmentIssue | null = null,
    ): FlightAlignmentStatus => ({
      reason,
      issue,
      elapsed,
      requiredSeconds: this.windowSeconds,
      solution,
    });
    if (!last) return result("collecting-imu");
    if (now - last.time > 0.5) return result("imu-stale");
    if (elapsed < this.windowSeconds - MAX_IMU_INTERVAL || this.imu.length < 30 || this.resumedAt !== null)
      return result(this.poseChanged ? "pose-changed" : "collecting-imu");

    // Match propagation's sample-and-hold intervals. Sensor cadence must not
    // give one part of a rocking/vibrating window more weight than another.
    const weights = this.imu.map((sample, i) => this.imu[i + 1] ? observedInterval(sample, this.imu[i + 1]!) : 0);
    const mean = (key: "gyro" | "specificForce"): Vec3 =>
      scale(
        this.imu.reduce<Vec3>(
          (sum, sample, i) => add(sum, scale(sample[key], weights[i]!)),
          [0, 0, 0],
        ),
        1 / elapsed,
      );
    const force = mean("specificForce"),
      gyro = mean("gyro");
    const forceRms = Math.sqrt(
      this.imu.reduce(
        (sum, s, i) => sum + weights[i]! * norm(sub(s.specificForce, force)) ** 2,
        0,
      ) / elapsed,
    );
    const gyroRms = Math.sqrt(
      this.imu.reduce((sum, s, i) => sum + weights[i]! * norm(sub(s.gyro, gyro)) ** 2, 0) / elapsed,
    );
    // Raw sample scatter includes sensor noise, not just movement. Apply the
    // motion thresholds to short means, while retaining separate raw-noise,
    // gravity and mean-rate bounds. Sustained rotation above the mean-rate
    // limit must still prevent alignment.
    const means = steadyMeans(this.imu, weights);
    const spread = (key: "gyro" | "specificForce", center: Vec3) => Math.sqrt(
      means.reduce((sum, sample) => sum + norm(sub(sample[key], center)) ** 2, 0) / means.length,
    );
    const forceChange = spread("specificForce", force), gyroChange = spread("gyro", gyro);
    const checks: FlightAlignmentIssue[] = [
      { kind: "force-magnitude", value: Math.abs(norm(force) - G), limit: 0.08 * G },
      { kind: "gyro-rate", value: norm(gyro), limit: 1 * RAD },
      // A mounted device in level flight need not be motionless. Allow vibration
      // and gentle rocking around the confirmed reference pose.
      // Bound raw input as well as displacement. High instantaneous rates alone
      // cannot distinguish small mount vibration from a changing level pose.
      { kind: "force-noise", value: forceRms, limit: G },
      { kind: "gyro-noise", value: gyroRms, limit: 50 * RAD },
      { kind: "angular-scatter", value: angularScatter(this.imu, weights, gyro, elapsed), limit: 1 * RAD },
      { kind: "force-change", value: forceChange, limit: 0.75 },
      { kind: "gyro-change", value: gyroChange, limit: 1 * RAD },
    ];
    const issue = checks.find(check => check.value > check.limit);
    if (issue) return result("imu-unstable", null, issue);

    const d = scale(unit(force), -1);
    const solution: FlightAlignmentSolution = {
      gpsVerified: false,
      time: last.time,
      specificForce: force,
      gyroBias: gyro,
      // Slow aircraft rotation cannot be distinguished from bias in this window.
      // Slow rocking is correlated across samples: do not divide that ambiguity
      // away as if it were independent sensor noise.
      gyroBiasStd: Math.max(0.2 * RAD, gyroChange,
        gyroRms * Math.sqrt(weights.reduce((sum, dt) => sum + dt * dt, 0)) / elapsed),
      levelTrim: fromEuler(
        Math.atan2(d[1], d[2]),
        Math.atan2(-d[0], Math.hypot(d[1], d[2])),
        0,
      ),
    };
    const unavailable = (reason: "gps-stale" | "gps-unusable" | "collecting-gps") =>
      this.allowUnaided ? result("ready", solution) : result(reason);
    const usable = (fix: FlightGpsSample) =>
      fix.accuracy >= 0 &&
      fix.accuracy <= 50 &&
      (!fix.estimated || this.allowEstimatedMotion) &&
      (fix.velocityNed
        ? finiteVector(fix.velocityNed) &&
          Math.hypot(fix.velocityNed[0], fix.velocityNed[1]) >= MIN_FLIGHT_GPS_SPEED
        : fix.speed !== null &&
          Number.isFinite(fix.speed) &&
          fix.speed >= MIN_FLIGHT_GPS_SPEED &&
          fix.track !== null &&
          Number.isFinite(fix.track));
    const recent = this.gps.filter(
      (fix) => fix.time >= this.imu[0]!.time && fix.time <= last.time,
    );
    const fixes = recent.filter(usable);
    // Even a partial GPS window can contradict the steady-motion assumption.
    // Check it before allowing an unverified fallback for missing evidence.
    const horizontal = fixes.map((fix): readonly [number, number] =>
      fix.velocityNed
        ? [fix.velocityNed[0], fix.velocityNed[1]]
        : [
            fix.speed! * Math.cos(fix.track! * RAD),
            fix.speed! * Math.sin(fix.track! * RAD),
          ],
    );
    const first = horizontal[0]!;
    if (
      horizontal.some((v) => Math.hypot(v[0] - first[0], v[1] - first[1]) > 3)
    )
      return result("gps-unstable");
    if (fixes.some((fix) => fix.velocityNed && Math.abs(fix.velocityNed[2]) > 1.5))
      return result("vertical-motion");

    if (this.gps.length && now - this.gps.at(-1)!.time > 3)
      return unavailable("gps-stale");
    if (recent.length && !usable(recent.at(-1)!)) return unavailable("gps-unusable");
    if (fixes.length < 3) {
      return unavailable(recent.length >= 3 ? "gps-unusable" : "collecting-gps");
    }
    if (fixes.at(-1)!.time - fixes[0]!.time + TIME_EPSILON < this.windowSeconds * 0.8)
      return unavailable("collecting-gps");
    if (now - fixes.at(-1)!.time > 3) return unavailable("gps-stale");

    if (this.requireVerticalEvidence && !fixes.every((fix) => fix.velocityNed)) {
      const altitude = fixes.filter(
        (fix) =>
          fix.altitude != null &&
          Number.isFinite(fix.altitude) &&
          fix.altitudeAccuracy != null &&
          Number.isFinite(fix.altitudeAccuracy) &&
          fix.altitudeAccuracy <= 30,
      );
      if (
        altitude.length < 3 ||
        altitude.at(-1)!.time - altitude[0]!.time + TIME_EPSILON < this.windowSeconds * 0.8
      )
        return result("vertical-evidence-unavailable");
      const tMean =
        altitude.reduce((sum, fix) => sum + fix.time, 0) / altitude.length;
      const hMean =
        altitude.reduce((sum, fix) => sum + fix.altitude!, 0) / altitude.length;
      const numerator = altitude.reduce(
        (sum, fix) => sum + (fix.time - tMean) * (fix.altitude! - hMean),
        0,
      );
      const denominator = altitude.reduce(
        (sum, fix) => sum + (fix.time - tMean) ** 2,
        0,
      );
      if (Math.abs(numerator / denominator) > 1.5)
        return result("vertical-motion");
    }

    return result("ready", { ...solution, gpsVerified: true });
  }
}
