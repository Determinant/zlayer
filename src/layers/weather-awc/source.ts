import { isRecord, isAwcAdvisorySnapshot, isWeatherAdvisory, type AwcAdvisoryIssue, type AwcAdvisoryProduct,
  type AwcAdvisorySnapshot, type WeatherAdvisory, type WeatherGeometry } from '@zlayer/contracts';
import { prepareAdvisoryGeometry } from './source-geometry';

export const FORECAST_HOURS = [0, 3, 6, 9, 12] as const;
export type SourceFeature = { type: 'Feature'; properties: Record<string, unknown>; geometry: WeatherGeometry };
export type SourceCollection = { type: 'FeatureCollection'; features: unknown[] };

/** Envelope completeness and member interpretation are independent. Unknown
 * members remain accounted for as source issues; truncation rejects the envelope. */
export function isSourceCollection(v: unknown): v is SourceCollection {
  return isRecord(v) && v.type === 'FeatureCollection' && v.exceededTransferLimit !== true &&
    Array.isArray(v.features) && v.features.length < 400;
}

function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}
const string = (v: unknown): string => typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
function height(value: unknown, hundreds = false): string {
  const raw = string(value);
  if (!raw) return 'unspecified';
  return /^\d+$/.test(raw) ? `${(Number(raw) * (hundreds ? 100 : 1)).toLocaleString('en-US')} ft` : raw;
}
function altitude(p: Record<string, unknown>, product: AwcAdvisoryProduct): string {
  if (product !== 'gairmet') {
    // Numeric SIGMET bounds can encode open-ended ranges (e.g. TOPS ABV FL450
    // exposes 45000/60000). A CWA's single top can also omit that qualifier.
    // Keep an explicit coded tops clause intact; otherwise defer to the bulletin.
    const bulletin = string(p.rawAirSigmet ?? p.cwaText);
    return /\bTOPS?\s+(?:TO|ABV|BLW)\s+(?:FL\d{2,3}|\d{2,5})\b/.exec(bulletin)?.[0]
      ?? 'See bulletin for vertical extent';
  }
  if (p.level !== undefined) return `${height(p.level, true)} MSL`;
  const lower = p.base, upper = p.top;
  if (lower == null && upper == null) return 'Vertical extent unspecified';
  let result = `Base ${height(lower, true)} · Top ${height(upper, true)}`;
  if (p.base === 'FZL') result += ` · Freezing ${height(p.fzlbase, true)}–${height(p.fzltop, true)}`;
  return result;
}
function identity(value: unknown): string {
  let hash = 14695981039346656037n;
  for (const char of JSON.stringify(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(char.charCodeAt(0))) * 1099511628211n);
  return hash.toString(16);
}

export function normalizeAdvisories(product: AwcAdvisoryProduct, inputs: readonly unknown[],
  checkedAt: number, source: string): AwcAdvisorySnapshot {
  if (inputs.length !== (product === 'gairmet' ? FORECAST_HOURS.length : 1) || !inputs.every(isSourceCollection)) {
    throw new Error('AWC returned an incomplete or unsupported advisory collection');
  }
  const advisories = new Map<string, WeatherAdvisory>(), issues = new Map<string, AwcAdvisoryIssue>();
  const bases = new Set<number>();
  for (const [index, collection] of inputs.entries()) for (const feature of collection.features) {
    const p = isRecord(feature) && isRecord(feature.properties) ? feature.properties : {};
    const issuer = string(p.icaoId ?? p.cwsu ?? p.product) || 'AWC';
    const identifier = string(p.seriesId ?? p.tag) || 'Unknown identifier';
    const reject = (reason: AwcAdvisoryIssue['reason']) => {
      const id = `${product}:issue:${identity(feature)}`, sourceFeature = JSON.stringify(feature) ?? 'null';
      issues.set(id, { id, issuer: issuer.slice(0, 100_000), identifier: identifier.slice(0, 100_000), reason,
        sourceFeature: sourceFeature.slice(0, 100_000), ...(sourceFeature.length > 100_000 ? { sourceFeatureTruncated: true } : {}) });
    };
    if (!isRecord(feature) || feature.type !== 'Feature' || !isRecord(feature.properties)) { reject('invalid-feature'); continue; }
    // AWC can leave a CWA's parsed hazard null while supplying a valid bulletin.
    // Keep it inspectable without guessing a classification from the source text.
    const hazard = product === 'cwa' && p.hazard == null ? 'UNK'
      : typeof p.hazard === 'string' ? p.hazard.trim() : '';
    const validFrom = instant(product === 'gairmet' ? p.validTime : p.validTimeFrom);
    const validTo = product === 'gairmet' ? null : instant(p.validTimeTo);
    const forecastHour = product === 'gairmet' && typeof p.forecast === 'number' ? p.forecast : null;
    if (validFrom === null || (product !== 'gairmet' && (validTo === null || validTo <= validFrom)) ||
      (product === 'gairmet' && forecastHour !== FORECAST_HOURS[index])) {
      if (product === 'gairmet') throw new Error('AWC advisory has invalid forecast times');
      reject('invalid-validity'); continue;
    }
    if (forecastHour !== null) bases.add(validFrom - forecastHour * 3_600_000);
    if (!hazard) { reject('invalid-hazard'); continue; }
    let prepared: ReturnType<typeof prepareAdvisoryGeometry>;
    try { prepared = prepareAdvisoryGeometry(feature.geometry); }
    catch { reject('invalid-geometry'); continue; }
    const { geometry, outlineGeometry } = prepared;
    // Include prepared geometry so upgraded interpretation cannot reuse a stale
    // renderer receipt for an unchanged source feature restored from storage.
    const id = `${product}:${issuer}:${identifier}:${identity([feature, geometry, outlineGeometry ?? null])}`;
    const advisory: WeatherAdvisory = { id, product, identifier, issuer, hazard,
      ...(product === 'gairmet' && typeof p.severity === 'string' && p.severity.trim() ? { severity: p.severity.trim() } : {}),
      issuedAt: instant(p.issueTime ?? p.creationTime), validFrom, validTo, forecastHour,
      altitude: altitude(p, product), text: string(p.rawAirSigmet ?? p.cwaText ?? p.dueTo),
      geometry, sourceProperties: p, ...(outlineGeometry ? { outlineGeometry } : {}),
      ...(JSON.stringify(geometry) !== JSON.stringify(feature.geometry) ? { sourceGeometry: JSON.stringify(feature.geometry) } : {}) };
    if (!isWeatherAdvisory(advisory)) { reject('invalid-feature'); continue; }
    advisories.set(id, advisory);
  }
  if (bases.size > 1) throw new Error('G-AIRMET forecast package changed during refresh; retaining the previous package');
  const base = [...bases][0];
  const snapshot: AwcAdvisorySnapshot = { schemaVersion: issues.size ? 2 : 1, product, checkedAt, source,
    frameTimes: base === undefined ? [] : FORECAST_HOURS.map(hour => base + hour * 3_600_000),
    advisories: [...advisories.values()], ...(issues.size ? { issues: [...issues.values()] } : {}) };
  if (!isAwcAdvisorySnapshot(snapshot)) throw new Error('AWC advisory normalization failed validation');
  return snapshot;
}
