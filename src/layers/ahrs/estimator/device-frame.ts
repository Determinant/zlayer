import type { Vec3 } from "./math.js";

export type Mount = "upright" | "flat";

export interface RawMotionSample {
  time: number;
  /** Browser alpha, beta, gamma in rad/s, BEFORE interpreting their axes. */
  rotationRate: Vec3;
  /** Browser x, y, z in m/s², BEFORE polarity/mount/trim corrections. */
  acceleration: Vec3;
}
/** Hardware XYZ → forward/right/down. Independent of display rotation. */
export function deviceToBody(v: Vec3, mount: Mount): Vec3 {
  return mount === "upright" ? [-v[2], v[0], -v[1]] : [v[1], v[0], -v[2]];
}
