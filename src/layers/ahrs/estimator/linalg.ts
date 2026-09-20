/** Small dense, row-major matrices. No inverses: measurement solves use Cholesky.
 * Internal callers supply the declared dimensions. Indexed assertions here and
 * in the ESKF refer to entries bounded by those dimensions (joint state or observation axes).
 */
export type Matrix = Float64Array;
export const zeros = (rows: number, cols = rows): Matrix =>
  new Float64Array(rows * cols);
export function identity(n: number): Matrix {
  const a = zeros(n);
  for (let i = 0; i < n; i++) a[i * n + i] = 1;
  return a;
}
export function transpose(a: Matrix, rows: number, cols: number): Matrix {
  const out = zeros(cols, rows);
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) out[j * rows + i] = a[i * cols + j]!;
  return out;
}
export function product(
  a: Matrix,
  b: Matrix,
  rows: number,
  inner: number,
  cols: number,
): Matrix {
  const out = zeros(rows, cols);
  for (let i = 0; i < rows; i++)
    for (let k = 0; k < inner; k++) {
      const x = a[i * inner + k]!;
      if (x === 0) continue;
      for (let j = 0; j < cols; j++) out[i * cols + j]! += x * b[k * cols + j]!;
    }
  return out;
}
export function sandwich(
  a: Matrix,
  p: Matrix,
  rows: number,
  inner: number,
): Matrix {
  return product(
    product(a, p, rows, inner, inner),
    transpose(a, rows, inner),
    rows,
    inner,
    rows,
  );
}
export function cholesky(a: Matrix, n: number): Matrix | null {
  const l = zeros(n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j]!;
      for (let k = 0; k < j; k++) sum -= l[i * n + k]! * l[j * n + k]!;
      if (i === j) {
        if (!(sum > 0) || !Number.isFinite(sum)) return null;
        l[i * n + j] = Math.sqrt(sum);
      } else l[i * n + j] = sum / l[j * n + j]!;
    }
  return l;
}
export function solve(l: Matrix, b: ArrayLike<number>, n: number): Matrix {
  const x = zeros(n, 1);
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let j = 0; j < i; j++) sum -= l[i * n + j]! * x[j]!;
    x[i] = sum / l[i * n + i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let sum = x[i]!;
    for (let j = i + 1; j < n; j++) sum -= l[j * n + i]! * x[j]!;
    x[i] = sum / l[i * n + i]!;
  }
  return x;
}
export function symmetrize(p: Matrix, n: number): void {
  for (let i = 0; i < n; i++)
    for (let j = 0; j < i; j++) {
      const value = (p[i * n + j]! + p[j * n + i]!) / 2;
      p[i * n + j] = p[j * n + i] = value;
    }
}
export function skew(v: readonly number[]): Matrix {
  return new Float64Array([0, -v[2]!, v[1]!, v[2]!, 0, -v[0]!, -v[1]!, v[0]!, 0]);
}

/** Solve X B = A with partial pivoting, without forming B⁻¹. Used only for
 * fundamental transition matrices; innovation systems remain Cholesky solves. */
export function rightSolve(a: Matrix, b: Matrix, n: number): Matrix | null {
  const left = transpose(b, n, n), right = transpose(a, n, n);
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(left[i * n + k]!) > Math.abs(left[pivot * n + k]!)) pivot = i;
    if (!Number.isFinite(left[pivot * n + k]) || Math.abs(left[pivot * n + k]!) < 1e-12) return null;
    if (pivot !== k) for (let j = 0; j < n; j++) {
      [left[k * n + j], left[pivot * n + j]] = [left[pivot * n + j]!, left[k * n + j]!];
      [right[k * n + j], right[pivot * n + j]] = [right[pivot * n + j]!, right[k * n + j]!];
    }
    for (let i = k + 1; i < n; i++) {
      const factor = left[i * n + k]! / left[k * n + k]!;
      left[i * n + k] = 0;
      for (let j = k + 1; j < n; j++) left[i * n + j]! -= factor * left[k * n + j]!;
      for (let j = 0; j < n; j++) right[i * n + j]! -= factor * right[k * n + j]!;
    }
  }
  for (let i = n - 1; i >= 0; i--) for (let column = 0; column < n; column++) {
    let value = right[i * n + column]!;
    for (let j = i + 1; j < n; j++) value -= left[i * n + j]! * right[j * n + column]!;
    right[i * n + column] = value / left[i * n + i]!;
  }
  return transpose(right, n, n);
}
