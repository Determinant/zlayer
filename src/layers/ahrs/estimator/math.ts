/** Right-handed body FRD → world NED. Angles in radians; quaternion [w,x,y,z]. */
export type Vec3 = readonly [number, number, number];
export type Quaternion = readonly [number, number, number, number];
export const G = 9.80665;
export const RAD = Math.PI / 180;
export const norm = (a: Vec3) => Math.hypot(...a);
export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const scale = (a: Vec3, s: number): Vec3 => [
  a[0] * s,
  a[1] * s,
  a[2] * s,
];
export const unit = (a: Vec3): Vec3 => scale(a, 1 / (norm(a) || 1));
export const dot = (a: Vec3, b: Vec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
export const wrap = (a: number) => ((a % 360) + 360) % 360;
export const finiteVector = (a: unknown): a is Vec3 =>
  Array.isArray(a) &&
  a.length === 3 &&
  Number.isFinite(a[0]) &&
  Number.isFinite(a[1]) &&
  Number.isFinite(a[2]);
export const conjugate = (q: Quaternion): Quaternion => [
  q[0],
  -q[1],
  -q[2],
  -q[3],
];
export function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export function normalize(q: Quaternion): Quaternion {
  const n = Math.hypot(...q);
  return n > 0 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [1, 0, 0, 0];
}
export function rotate(q: Quaternion, v: Vec3): Vec3 {
  const t = scale(cross([q[1], q[2], q[3]], v), 2);
  return add(v, add(scale(t, q[0]), cross([q[1], q[2], q[3]], t)));
}
export function fromEuler(
  roll: number,
  pitch: number,
  yaw: number,
): Quaternion {
  const c: Vec3 = [Math.cos(roll / 2), Math.cos(pitch / 2), Math.cos(yaw / 2)];
  const s: Vec3 = [Math.sin(roll / 2), Math.sin(pitch / 2), Math.sin(yaw / 2)];
  return [
    c[0] * c[1] * c[2] + s[0] * s[1] * s[2],
    s[0] * c[1] * c[2] - c[0] * s[1] * s[2],
    c[0] * s[1] * c[2] + s[0] * c[1] * s[2],
    c[0] * c[1] * s[2] - s[0] * s[1] * c[2],
  ];
}
export function toEuler(q: Quaternion): {
  roll: number;
  pitch: number;
  yaw: number;
} {
  const [w, x, y, z] = q;
  return {
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    pitch: Math.asin(clamp(2 * (w * y - z * x), -1, 1)),
    yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  };
}
/** Exact constant-rate increment, avoiding Euler integration's rate dependence. */
export function integrate(q: Quaternion, rate: Vec3, dt: number): Quaternion {
  const speed = norm(rate),
    half = (speed * dt) / 2;
  if (speed < 1e-12) return q;
  const v = scale(rate, Math.sin(half) / speed);
  return normalize(multiply(q, [Math.cos(half), ...v]));
}

/** Minimal rotation taking one nonzero vector onto another, including antipodes. */
export function rotationBetween(from: Vec3, to: Vec3): Quaternion {
  const a = unit(from), b = unit(to), cosine = clamp(dot(a, b), -1, 1);
  if (cosine < -1 + 1e-10) {
    const axis = unit(cross(a, Math.abs(a[0]) < .8 ? [1, 0, 0] : [0, 1, 0]));
    return [0, ...axis];
  }
  return normalize([1 + cosine, ...cross(a, b)]);
}
