import type { Quaternion, Vec3 } from "./math.js";
export type CorrectionResult = 'accepted' | 'innovation' | 'attitude-limit' | 'bias-limit' | 'covariance' | 'iteration-limit';
export interface Observation {
  source: 'velocity' | 'velocity-change' | 'altitude' | 'tilt' | 'magnetic';
  time: number;
  dimension: number;
  /** Innovation in the update's linearization, SI units in its observation basis.
   * Iterated updates include recentering against the original prior. */
  residual: number[];
  /** Present for a fixed-prior iterated observation; covariance is committed once. */
  iterations?: number;
  /** Present for covariance intersection with unknown sensor correlation. */
  priorWeight?: number;
  /** Row-major innovation covariance, before gating/injection. Null for initialization. */
  covariance: number[] | null;
  nis: number | null;
  gate: number | null;
  result: CorrectionResult | 'initialized' | 'geometry' | 'uninformative';
}
export type ObservationListener = (observation: Observation & { replayed: boolean }) => void;
/** Observation times in one monotonic clock, in seconds. The browser adapter
 * uses event creation time as its documented proxy for hardware acquisition. */
export interface ImuSample {
  time: number;
  /** Angular rates in body forward/right/down axes, radians/second. */
  gyro: Vec3;
  /** Accelerometer specific force in body forward/right/down axes, m/s². */
  specificForce: Vec3;
}
/** Magnetic evidence sharing the IMU clock; vectors/axes share its body frame.
 * Browser orientation is already OS-fused; it is not a raw field measurement.
 * No source is interpreted as an absolute north observation. */
export type MagneticSample = { time: number } & (
  // Platform-calibrated field components, µT.
  | { source: 'magnetometer'; vector: Vec3 }
  // Unit reference vector reconstructed from absolute browser orientation.
  | { source: 'absolute-orientation'; vector: Vec3 }
  // Browser heading/accuracy in degrees, with a unit reference axis in body axes.
  | { source: 'webkit-compass'; heading: number; accuracy: number; axis: Vec3 }
);
export type MagneticReference = { source: MagneticSample['source']; scale: number;
  /** Initial OS heading error is part of every relative observation, not a new
   * independent north measurement. Covariance intersection retains its sharing. */
  initialVariance?: number };
export interface GpsFix {
  /** Acquisition time in the same monotonic seconds as the IMU. */
  time: number;
  /** Horizontal ground speed, m/s. */
  speed: number | null;
  /** Ground track clockwise from true north, degrees; not aircraft heading. */
  track: number | null;
  /** Horizontal position accuracy, metres; used for quality gating only. */
  accuracy: number;
  /** Position-derived speed/track is unsuitable for inertial aiding. */
  estimated?: boolean;
  /** Altitude in metres, using a consistent provider datum. */
  altitude: number | null;
  /** Altitude accuracy in metres, interpreted as a 95% interval half-width. */
  altitudeAccuracy: number | null;
  /** Optional directly measured NED velocity, m/s (including positive-down vertical velocity). */
  velocityNed?: Vec3;
  /** Independent per-axis velocity standard deviations, m/s, NOT position accuracy. */
  velocityStd?: Vec3;
}
export interface AhrsOptions {
  gpsAiding?: boolean;
  /** Joint acceleration/gravity observations. False selects conventional
   * strapdown INS, consuming force only as a process input. Default true. */
  gravityAiding?: boolean;
  maxGap?: number;
  /** Resume after missing IMU data, retaining pose/bias and increasing uncertainty. Default false. */
  recoverAfterGap?: boolean;
  historySeconds?: number;
  /** Continuous white gyro noise density, rad/s/sqrt(Hz). */
  gyroNoise?: number;
  /** Continuous white accelerometer noise density, m/s²/sqrt(Hz). */
  accelNoise?: number;
  /** Gyro bias random walk, rad/s/sqrt(s). */
  gyroBiasWalk?: number;
  /** Accelerometer bias random walk, m/s²/sqrt(s). */
  accelBiasWalk?: number;
  /** Quiet-flight transient acceleration driving noise, m/s²/sqrt(s); rotation adds a maneuver allowance. */
  accelerationWalk?: number;
  /** Slow sustained-acceleration random walk, m/s²/sqrt(s); no pull toward zero. */
  persistentAccelerationWalk?: number;
  /** Transient acceleration correlation time, seconds. */
  accelerationTimeConstant?: number;
  /** Persistent unresolved acceleration standard deviation, m/s². */
  initialAccelerationStd?: number;
  initialGyroBiasStd?: number;
  initialAccelBiasStd?: number;
  initialTiltStd?: number; // degrees
  initialHeadingStd?: number; // degrees, for an explicit heading alignment
  gpsVelocityStd?: number; // m/s; browser does not report velocity accuracy
  maxTiltStd?: number; // degrees; uncertainty warning threshold, not an integrity guarantee
}
export interface Attitude {
  /** Body FRD → local-level rotation, quaternion [w, x, y, z]. North-aligned only while headingStatus is tracking. */
  quaternion: Quaternion;
  /** Roll and pitch in degrees. */
  roll: number;
  pitch: number;
  /** Clockwise yaw in [0, 360) degrees, relative or true as indicated below. */
  yaw: number;
  /** Source of the most recent alignment; history, not current validity. */
  headingReference: "relative" | "manual-true" | "gps-inertial";
  headingStatus: "acquiring" | "tracking" | "recovering";
  headingReason: string;
  status:
    | "waiting"
    | "tracking"
    | "coasting"
    | "degraded"
    | "stale"
    | "interrupted";
  reason: string;
  /** Seconds since the latest IMU sample; Infinity before the first sample. */
  age: number;
  /** Smoothed IMU sample rate, Hz. */
  rate: number;
  /** Specific-force magnitude divided by standard gravity. */
  load: number;
  /** Estimated body gyro bias, radians/second. */
  bias: Vec3;
  /** Estimated body accelerometer bias, m/s². */
  accelBias: Vec3;
  /** Estimated velocity, m/s; north/east/down after heading alignment. */
  velocity: Vec3;
  /** Model-based 1σ Euler angle uncertainties, degrees. Not calibrated accuracy bounds.
   * Heading uncertainty is Infinity during acquisition and recovery.
   */
  attitudeStd: Vec3;
  /** Largest model-based 1σ tilt error, degrees, independent of yaw/Euler singularities. */
  tiltStd: number;
  /** Local yaw uncertainty; absolute north can still be unknown. */
  relativeYawStd: number;
  gyroBiasStd: Vec3;
  accelBiasStd: Vec3;
  /** Compatibility alias for active gravity/acceleration aiding. */
  gravityCorrection: boolean;
  /** Recent gravity/acceleration correction in the local-level frame. */
  tiltAiding: boolean;
  magneticFusion: {
    mode: 'qualifying' | 'heading' | 'vector' | 'rejected';
    active: boolean; source: MagneticSample['source'] | null; reason: string;
    accepted: number; rejected: number; age: number;
  };
  /** Recent accepted navigation velocity correction, after heading alignment. */
  gpsAiding: boolean;
  gps: GpsFix | null;
  /** Seconds since the latest valid received GPS fix. */
  gpsAge: number;
  /** Seconds since the latest accepted GPS velocity observation. */
  fusionAge: number;
  tiltFusion: { source?: 'imu' | null; accepted: number; rejected: number; nis: number | null; reason: string; lastFusion: number; age: number };
  /** Positive-up vertical speed, m/s; null without recent vertical aiding. */
  verticalSpeed: number | null;
  fusion: {
    accepted: number;
    rejected: number;
    stale: number;
    nis: number | null;
    reason: string;
  };
  altitudeFusion: { accepted: number; rejected: number; nis: number | null; reason: string };
}
