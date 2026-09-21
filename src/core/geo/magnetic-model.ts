import { isRecord, isIsoDate } from '@zlayer/contracts';
type Position = readonly [longitude: number, latitude: number];
const RAD = Math.PI / 180;
const wrap = (degrees: number) => ((degrees % 360) + 360) % 360;
const validPosition = (position: Position) => position.length === 2 && position.every(Number.isFinite) &&
  Math.abs(position[0]) <= 180 && Math.abs(position[1]) <= 90;

type Coefficient = readonly [n: number, m: number, g: number, h: number, gDot: number, hDot: number];
export type MagneticModel = {
  type: 'ZLayerMagneticModel'; schemaVersion: 1; effectiveDate: string;
  model: 'WMM-2025'; epoch: 2025; validFrom: '2025-01-01'; validUntil: '2030-01-01';
  maxDegree: 12; referenceRadiusKm: 6371.2; coefficients: readonly Coefficient[];
};

/** Accept only the conventions this evaluator implements, including all 90 terms. */
export function isMagneticModel(value: unknown): value is MagneticModel {
  if (!isRecord(value) || value.type !== 'ZLayerMagneticModel' || value.schemaVersion !== 1 ||
    !isIsoDate(value.effectiveDate) || value.model !== 'WMM-2025' || value.epoch !== 2025 ||
    value.validFrom !== '2025-01-01' || value.validUntil !== '2030-01-01' || value.maxDegree !== 12 ||
    value.referenceRadiusKm !== 6371.2 || value.coverage !== 'global' || value.coordinateSystem !== 'WGS84' ||
    value.altitudeReference !== 'ellipsoid' || value.normalization !== 'schmidt-semi-normalized' ||
    value.coefficientUnits !== 'nT' || value.secularVariationUnits !== 'nT/year' ||
    value.declinationConvention !== 'east-positive' ||
    JSON.stringify(value.coefficientFields) !== '["n","m","g","h","gDot","hDot"]' ||
    !Array.isArray(value.coefficients) || value.coefficients.length !== 90) return false;
  let index = 0;
  for (let n = 1; n <= 12; n++) for (let m = 0; m <= n; m++) {
    const row: unknown = value.coefficients[index++];
    if (!Array.isArray(row) || row.length !== 6 || !row.every(Number.isFinite) ||
      row[0] !== n || row[1] !== m || (m === 0 && (row[3] !== 0 || row[5] !== 0))) return false;
  }
  return true;
}

export const magneticBearing = (trueDegrees: number, eastDeclination: number): number => wrap(trueDegrees - eastDeclination);

export function decimalYear(time: number): number {
  const year = new Date(time).getUTCFullYear();
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
  return year + (time - start) / (end - start);
}

const normalized = new WeakMap<MagneticModel, readonly Coefficient[]>();
function unnormalized(model: MagneticModel): readonly Coefficient[] {
  let coefficients = normalized.get(model);
  if (coefficients) return coefficients;
  let zonal = 1, factor = 1;
  coefficients = model.coefficients.map(([n, m, g, h, gDot, hDot]) => {
    if (m === 0) { zonal *= (2 * n - 1) / n; factor = zonal; }
    else factor *= Math.sqrt((n - m + 1) * (m === 1 ? 2 : 1) / (n + m));
    return [n, m, g * factor, h * factor, gDot * factor, hDot * factor];
  });
  normalized.set(model, coefficients);
  return coefficients;
}

export type MagneticField = { declination: number; north: number; east: number; down: number; horizontal: number };

/** NOAA WMM spherical harmonics and WGS84 conversion, adapted from its public-domain
 * legacy geomag.c. Coefficients come from the chart feed, never from a nearby VOR.
 * https://www.ncei.noaa.gov/products/world-magnetic-model
 * Height is meters above the WGS84 ellipsoid; absent GPS height uses zero.
 */
export function magneticField(model: MagneticModel, position: Position, altitude: number | null,
  time: number): MagneticField | null {
  if (!validPosition(position) || !Number.isFinite(time) || time < Date.parse(model.validFrom) ||
    time >= Date.parse(model.validUntil)) return null;
  const height = (altitude ?? 0) / 1000;
  if (!Number.isFinite(height) || height < -1 || height > 850) return null;
  const [longitude, latitude] = position;
  const sinLat = Math.sin(latitude * RAD), cosLat = Math.cos(latitude * RAD);
  const a2 = 6378.137 ** 2, b2 = 6356.7523142 ** 2, c2 = a2 - b2;
  const q = Math.sqrt(a2 - c2 * sinLat ** 2), q1 = height * q;
  const q2 = ((q1 + a2) / (q1 + b2)) ** 2;
  const ct = sinLat / Math.sqrt(q2 * cosLat ** 2 + sinLat ** 2);
  const st = Math.sqrt(Math.max(0, 1 - ct * ct));
  const radius = Math.sqrt(height ** 2 + 2 * q1 + (a2 ** 2 - (a2 ** 2 - b2 ** 2) * sinLat ** 2) / (q * q));
  const d = Math.sqrt(a2 * cosLat ** 2 + b2 * sinLat ** 2);
  const ca = (height + d) / radius, sa = c2 * cosLat * sinLat / (radius * d);
  const size = model.maxDegree + 1;
  const p = new Float64Array(size * size), dp = new Float64Array(size * size);
  const polar = new Float64Array(size);
  p[0] = 1; polar[0] = 1;
  const dt = decimalYear(time) - model.epoch, ratio = model.referenceRadiusKm / radius;
  let radial = 0, theta = 0, east = 0, polarEast = 0;
  for (const [n, m, g0, h0, gDot, hDot] of unnormalized(model)) {
    const i = n * size + m, previous = i - size;
    const k = ((n - 1) ** 2 - m * m) / ((2 * n - 1) * (2 * n - 3));
    if (n === m) {
      p[i] = st * p[previous - 1]!;
      dp[i] = st * dp[previous - 1]! + ct * p[previous - 1]!;
    } else {
      const older = n > 1 ? p[i - 2 * size]! : 0;
      const olderDerivative = n > 1 ? dp[i - 2 * size]! : 0;
      p[i] = ct * p[previous]! - k * older;
      dp[i] = ct * dp[previous]! - st * p[previous]! - k * olderDerivative;
    }
    const g = g0 + dt * gDot, h = h0 + dt * hDot;
    const sin = Math.sin(m * longitude * RAD), cos = Math.cos(m * longitude * RAD);
    const first = g * cos + h * sin, second = g * sin - h * cos;
    const power = ratio ** (n + 2);
    theta -= power * first * dp[i]!;
    radial += (n + 1) * power * first * p[i]!;
    east += m * power * second * p[i]!;
    if (st === 0 && m === 1) {
      polar[n] = n === 1 ? 1 : ct * polar[n - 1]! - k * polar[n - 2]!;
      polarEast += power * second * polar[n]!;
    }
  }
  east = st === 0 ? polarEast : east / st;
  const north = -theta * ca - radial * sa, down = theta * sa - radial * ca;
  const horizontal = Math.hypot(north, east), declination = Math.atan2(east, north) / RAD;
  return [north, east, down, horizontal, declination].every(Number.isFinite)
    ? { north, east, down, horizontal, declination } : null;
}
