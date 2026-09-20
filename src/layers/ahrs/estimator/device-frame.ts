import { finiteVector } from "./math.js";
import type { Vec3 } from "./math.js";

export type Mount = "upright" | "flat";
/** Signed, one-based raw channel indices: [1,2,3] means alpha/beta/gamma → XYZ. */
export type AxisMap = readonly [number, number, number];
export const DEFAULT_GYRO_MAP: AxisMap = [1, 2, 3];

export interface RawMotionSample {
  time: number;
  /** Browser alpha, beta, gamma in rad/s, BEFORE interpreting their axes. */
  rotationRate: Vec3;
  /** Browser x, y, z in m/s², BEFORE polarity/mount/trim corrections. */
  acceleration: Vec3;
}
export interface SensorProfile {
  version: 1;
  gyroMap: AxisMap;
  accelerationSign: 1 | -1;
}
export function parseSensorProfile(text: string): SensorProfile {
  const { version, gyroMap, accelerationSign } = JSON.parse(text) ?? {};
  if (
    version !== 1 ||
    !validAxisMap(gyroMap) ||
    (accelerationSign !== 1 && accelerationSign !== -1)
  )
    throw new Error("Invalid sensor profile");
  return {
    version: 1,
    gyroMap: [...gyroMap],
    accelerationSign,
  };
}

export function validAxisMap(value: unknown): value is AxisMap {
  return (
    finiteVector(value) &&
    value.every(
      (v) => Number.isInteger(v) && Math.abs(v) >= 1 && Math.abs(v) <= 3,
    ) &&
    new Set(value.map(Math.abs)).size === 3
  );
}
export function mapAxes(v: Vec3, map: AxisMap): Vec3 {
  if (!validAxisMap(map)) throw new RangeError("Invalid gyro axis mapping");
  const channel = (axis: number) => Math.sign(axis) * v[Math.abs(axis) - 1]!;
  return [channel(map[0]), channel(map[1]), channel(map[2])];
}
/** Hardware XYZ → forward/right/down. Independent of display rotation. */
export function deviceToBody(v: Vec3, mount: Mount): Vec3 {
  return mount === "upright" ? [-v[2], v[0], -v[1]] : [v[1], v[0], -v[2]];
}
