export interface Px4Module {
  HEAPF64: Float64Array;
  _px4_create(): number;
  _px4_destroy(pointer: number): void;
  _px4_configure(pointer: number, gps: number, gravity: number, gyroNoise: number, accelNoise: number,
    gyroWalk: number, accelWalk: number, tiltStd: number, accelBiasStd: number): void;
  _px4_seed(pointer: number, x: number, y: number, z: number, std: number, pose: number,
    qw: number, qx: number, qy: number, qz: number): void;
  _px4_accel_bias(pointer: number, x: number, y: number, z: number, std: number): void;
  _px4_imu(pointer: number, time: number, gx: number, gy: number, gz: number, ax: number, ay: number, az: number): void;
  _px4_gps(pointer: number, time: number, lat: number, lon: number, alt: number, hacc: number, vacc: number,
    vn: number, ve: number, vd: number, sacc: number, horizontal: number, vertical: number, position: number, height: number, quality: number): void;
  _px4_mag(pointer: number, time: number, x: number, y: number, z: number): void;
  _px4_heading(pointer: number, radians: number, variance: number): void;
  _px4_ground(pointer: number, time: number, atRest: number, inAir: number): void;
  _px4_state(pointer: number): number;
  _px4_covariance(pointer: number): number;
}
export default function createModule(options?: { print?: (text: string) => void; printErr?: (text: string) => void }): Promise<Px4Module>;
