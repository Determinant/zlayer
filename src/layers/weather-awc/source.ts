import { isRecord, isAwcAdvisorySnapshot, isWeatherAdvisory, advisoryValidityWithinWindow, type AwcAdvisoryIssue, type AwcAdvisoryProduct,
  type AwcAdvisorySnapshot, type WeatherAdvisory, type WeatherGeometry } from '@zlayer/contracts';
import { prepareAdvisoryGeometry, AdvisoryGeometryError, AdvisoryGeometryProcessingError } from './source-geometry';
import { advisorySourceHazard } from './source-hazard';

export const FORECAST_HOURS = [0, 3, 6, 9, 12] as const;
export type SourceFeature = { type: 'Feature'; properties: Record<string, unknown>; geometry: WeatherGeometry };
export type SourceCollection = { type: 'FeatureCollection'; features: unknown[] };

/** Envelope completeness and member interpretation are independent. Unknown
 * members remain accounted for as source issues; truncation rejects the envelope. */
export function isSourceCollection(v: unknown, maxRecords = 399): v is SourceCollection {
  return isRecord(v) && v.type === 'FeatureCollection' && v.exceededTransferLimit !== true &&
    Array.isArray(v.features) && v.features.length <= maxRecords;
}

function instant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T.+(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts) return null;
  // Date.parse accepts overflowing calendar days (e.g. February 30). Such a
  // repair changes applicability, unlike an equivalent explicit UTC offset.
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
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
  checkedAt: number, source: string, completeBulk = false): AwcAdvisorySnapshot {
  if (inputs.length !== (product === 'gairmet' ? FORECAST_HOURS.length : 1) || !inputs.every(input => isSourceCollection(input, completeBulk && product === 'gairmet' ? 2000 : 399))) {
    throw new Error('AWC returned an incomplete or unsupported advisory collection');
  }
  if (inputs.reduce((count, input) => count + input.features.length, 0) > 2000) throw new Error('AWC advisory collection exceeds record limit');
  const advisories = new Map<string, WeatherAdvisory>(), issues = new Map<string, AwcAdvisoryIssue>();
  const bases = new Set<number>();
  for (const [index, collection] of inputs.entries()) for (const feature of collection.features) {
    const p = isRecord(feature) && isRecord(feature.properties) ? feature.properties : {};
    const issuer = string(p.icaoId ?? p.cwsu ?? p.product) || 'AWC';
    const identifier = string(p.seriesId ?? p.tag) || 'Unknown identifier';
    const reject = (reason: AwcAdvisoryIssue['reason'], detail?: AwcAdvisoryIssue['detail'], geometryError?: string) => {
      const id = `${product}:issue:${identity(feature)}`, sourceFeature = JSON.stringify(feature) ?? 'null';
      issues.set(id, { id, issuer: issuer.slice(0, 100_000), identifier: identifier.slice(0, 100_000), reason,
        ...(detail ? { detail } : {}), ...(geometryError ? { geometryError: geometryError.slice(0, 300) } : {}), sourceFeature: sourceFeature.slice(0, 100_000),
        ...(sourceFeature.length > 100_000 ? { sourceFeatureTruncated: true } : {}) });
    };
    if (!isRecord(feature) || feature.type !== 'Feature' || !isRecord(feature.properties)) { reject('invalid-feature'); continue; }
    const validFrom = instant(product === 'gairmet' ? p.validTime : p.validTimeFrom);
    const validTo = product === 'gairmet' ? null : instant(p.validTimeTo);
    const forecastHour = product === 'gairmet' && typeof p.forecast === 'number' ? p.forecast : null;
    if (validFrom === null || (product !== 'gairmet' && (validTo === null || validTo <= validFrom)) ||
      !advisoryValidityWithinWindow(validFrom, validTo, checkedAt) ||
      (product === 'gairmet' && forecastHour !== FORECAST_HOURS[index])) {
      if (product === 'gairmet' && !completeBulk) throw new Error('AWC advisory has invalid forecast times');
      reject('invalid-validity'); continue;
    }
    if (forecastHour !== null) bases.add(validFrom - forecastHour * 3_600_000);
    const resolution = advisorySourceHazard(product, p, validFrom, validTo);
    if (resolution.kind === 'issue') { reject('invalid-hazard', resolution.detail); continue; }
    const { hazard, classification } = resolution;
    let prepared: ReturnType<typeof prepareAdvisoryGeometry>;
    try { prepared = prepareAdvisoryGeometry(feature.geometry); }
    catch (cause) {
      if (!(cause instanceof AdvisoryGeometryError)) throw new AdvisoryGeometryProcessingError(cause);
      reject('invalid-geometry', undefined, cause.message); continue;
    }
    const { geometry, outlineGeometry } = prepared;
    // Include resolved classification and prepared geometry so an upgraded
    // interpretation cannot reuse a stale receipt for an unchanged source feature.
    const id = `${product}:${issuer}:${identifier}:${identity([feature, hazard, geometry, outlineGeometry ?? null])}`;
    const advisory: WeatherAdvisory = { id, product, identifier, issuer, hazard, classification,
      ...(product === 'gairmet' && typeof p.severity === 'string' && p.severity.trim() ? { severity: p.severity.trim() } : {}),
      issuedAt: instant(p.issueTime ?? p.creationTime), validFrom, validTo, forecastHour,
      altitude: altitude(p, product), text: string(p.rawAirSigmet ?? p.cwaText ?? p.dueTo),
      geometry, sourceProperties: p, ...(outlineGeometry ? { outlineGeometry } : {}),
      ...(JSON.stringify(geometry) !== JSON.stringify(feature.geometry) ? { sourceGeometry: JSON.stringify(feature.geometry) } : {}) };
    if (!isWeatherAdvisory(advisory)) { reject('invalid-feature'); continue; }
    advisories.set(id, advisory);
  }
  if (bases.size > 1 && !completeBulk) throw new Error('G-AIRMET forecast package changed during refresh; retaining the previous package');
  const cycles = [...bases].sort((a, b) => a - b);
  if (cycles.length > 32) throw new Error('G-AIRMET cycle limit exceeded');
  const snapshot: AwcAdvisorySnapshot = { schemaVersion: cycles.length > 1 ? 3 : issues.size ? 2 : 1, product, checkedAt, source,
    frameTimes: [...new Set(cycles.flatMap(base => FORECAST_HOURS.map(hour => base + hour * 3_600_000)))].sort((a, b) => a - b),
    ...(cycles.length > 1 ? { cycleTimes: cycles } : {}),
    advisories: [...advisories.values()], ...(issues.size ? { issues: [...issues.values()] } : {}) };
  if (!isAwcAdvisorySnapshot(snapshot)) throw new Error('AWC advisory normalization failed validation');
  return snapshot;
}

/** Older clients can draw only one cycle. Account for every omitted member as
 * explicit uncertainty, with original evidence, until they upgrade to v3. */
export function legacyAdvisories(snapshot: AwcAdvisorySnapshot): AwcAdvisorySnapshot {
  if (snapshot.schemaVersion !== 3) return snapshot;
  const { cycleTimes, ...rest } = snapshot, base = cycleTimes!.at(-1)!;
  const advisories: WeatherAdvisory[] = [], issues = [...(snapshot.issues ?? [])];
  for (const advisory of snapshot.advisories) {
    if (advisory.validFrom - advisory.forecastHour! * 3_600_000 === base) advisories.push(advisory);
    else {
      const evidence = JSON.stringify({ explanation: 'This valid overlapping cycle requires the v3 G-AIRMET endpoint', advisory });
      issues.push({ id: advisory.id, issuer: advisory.issuer, identifier: advisory.identifier, reason: 'invalid-validity',
        sourceFeature: evidence.slice(0, 100_000), ...(evidence.length > 100_000 ? { sourceFeatureTruncated: true as const } : {}) });
    }
  }
  return { ...rest, schemaVersion: issues.length ? 2 : 1, advisories,
    frameTimes: FORECAST_HOURS.map(hour => base + hour * 3_600_000), ...(issues.length ? { issues } : {}) };
}
