import { identity, product, skew } from "./linalg.js";
import type { Matrix } from "./linalg.js";

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
export function rotationMatrix(q: Quaternion): Matrix {
  const x = rotate(q, [1, 0, 0]),
    y = rotate(q, [0, 1, 0]),
    z = rotate(q, [0, 0, 1]);
  return new Float64Array([
    x[0],
    y[0],
    z[0],
    x[1],
    y[1],
    z[1],
    x[2],
    y[2],
    z[2],
  ]);
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

/** Stable coefficients of the first two integrals of Exp([rotation]×). */
function coefficients(theta: number): Vec3 {
  const t2 = theta * theta;
  if (theta < 0.01)
    return [
      1 / 2 - t2 / 24 + (t2 * t2) / 720,
      1 / 6 - t2 / 120 + (t2 * t2) / 5040,
      1 / 24 - t2 / 720 + (t2 * t2) / 40320,
    ];
  return [
    (1 - Math.cos(theta)) / t2,
    (theta - Math.sin(theta)) / (t2 * theta),
    (t2 / 2 + Math.cos(theta) - 1) / (t2 * t2),
  ];
}

/** d Log(Exp(-d) Exp(d+e)) / de at e=0. Solà (2017), equation 183. */
export function rightJacobian(d: Vec3) {
  const [a, b] = coefficients(norm(d)),
    W = skew(d),
    W2 = product(W, W, 3, 3, 3),
    J = identity(3);
  for (let i = 0; i < 9; i++) J[i]! += -a * W[i]! + b * W2[i]!;
  return J;
}

/** Integral on u∈[0,1] of Exp(u[d]×)f, and of (1-u)Exp(u[d]×)f.
 * Multiply by dt and dt², respectively, for velocity and position increments.
 */
export function forceIntegrals(d: Vec3, force: Vec3): [Vec3, Vec3] {
  const [a, b, c] = coefficients(norm(d)),
    first = cross(d, force),
    second = cross(d, first);
  return [
    add(force, add(scale(first, a), scale(second, b))),
    add(scale(force, 0.5), add(scale(first, b), scale(second, c))),
  ];
}

/** Euler-angle differential for a right/body perturbation; undefined at gimbal lock. */
export function eulerJacobian(q: Quaternion): Float64Array | null {
  const { roll, pitch } = toEuler(q),
    cp = Math.cos(pitch);
  if (Math.abs(cp) < 1e-6) return null;
  const sr = Math.sin(roll),
    cr = Math.cos(roll),
    tp = Math.tan(pitch);
  return new Float64Array([
    1,
    sr * tp,
    cr * tp,
    0,
    cr,
    -sr,
    0,
    sr / cp,
    cr / cp,
  ]);
}
