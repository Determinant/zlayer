import type { Quaternion, Vec3 } from "./math.js";
export interface Observation {
  source: 'velocity' | 'altitude' | 'tilt' | 'magnetic';
  time: number;
  dimension: number;
  /** Innovation in its observation basis: velocity m/s, height m, unit gravity
   * vector, or magnetic gauss. */
  residual: number[];
  /** Row-major innovation covariance, before gating/injection. Null for initialization. */
  covariance: number[] | null;
  /** PX4 exposes sequential per-axis variances, not a joint innovation matrix. */
  covarianceKind?: 'joint' | 'sequential-diagonal';
  gateKind?: 'chi-square' | 'per-axis-sigma';
  nis: number | null;
  gate: number | null;
  result: 'accepted' | 'innovation' | 'uninformative';
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
export interface GpsFix {
  /** WGS-84 longitude/latitude. Absent coordinates are never fused as position. */
  coordinates?: readonly [number, number];
  /** Acquisition time in the same monotonic seconds as the IMU. */
  time: number;
  /** Horizontal ground speed, m/s. */
  speed: number | null;
  /** Ground track clockwise from true north, degrees; not aircraft heading. */
  track: number | null;
  /** Horizontal position accuracy, metres, interpreted as a 95% interval half-width. */
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
  /** Enable PX4 gravity-vector aiding when horizontal aiding is unavailable. */
  gravityAiding?: boolean;
  maxGap?: number;
  /** Resume after missing IMU data, retaining pose/bias and increasing uncertainty. Default false. */
  recoverAfterGap?: boolean;
  /** PX4 angular-rate observation noise, rad/s. */
  gyroNoise?: number;
  /** PX4 acceleration observation noise, m/s². */
  accelNoise?: number;
  /** PX4 gyro-bias process noise, rad/s². */
  gyroBiasWalk?: number;
  /** PX4 accelerometer-bias process noise, m/s³. */
  accelBiasWalk?: number;
  initialGyroBiasStd?: number;
  initialAccelBiasStd?: number;
  initialTiltStd?: number; // degrees
  initialHeadingStd?: number; // degrees, for an explicit heading alignment
  gpsVelocityStd?: number; // m/s; browser does not report velocity accuracy
  maxTiltStd?: number; // degrees; uncertainty warning threshold, not an integrity guarantee
}
/** Host rest qualification at the latest processed IMU time, before PX4's delay.
 * SI units throughout; vibration metrics are smoothed sample-difference norms,
 * not RMS noise or hardware clipping measurements. */
export interface GroundDiagnostics {
  time: number;
  reason: string;
  gpsAge: number;
  speed: number | null;
  smoothedSpeed: number | null;
  /** Absolute reported vertical speed; null when unavailable. */
  verticalSpeed: number | null;
  /** Absolute difference between mean specific-force magnitude and gravity. */
  forceDeviation: number;
  angularRate: number;
  meanAngularRate: number;
  gyroVibration: number;
  accelVibration: number;
  stoppedFor: number;
  quietFor: number;
}
export interface Attitude {
  /** Automatic browser assessment used at PX4's delayed horizon. Unknown includes
   * flight; this is not an independent landing sensor or a pilot-operated mode. */
  groundState?: 'unknown' | 'landed' | 'at-rest';
  /** Absent before the first IMU sample and in historical snapshots. */
  groundDiagnostics?: GroundDiagnostics | undefined;
  /** Body FRD → local-level rotation, quaternion [w, x, y, z]. North-aligned only while headingStatus is tracking. */
  quaternion: Quaternion;
  /** Roll and pitch in degrees. */
  roll: number;
  pitch: number;
  /** Clockwise yaw in [0, 360) degrees, relative or true as indicated below. */
  yaw: number;
  /** PX4's accumulated gyro yaw in degrees, excluding aiding/reset jumps.
   * Absent in historical snapshots. Restarts when the native estimator restarts. */
  unaidedYaw?: number;
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
