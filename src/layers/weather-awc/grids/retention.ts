import { gridKey } from './format';
import { pluginFileKey } from '../../../core/storage/plugin-file-cache';
import { nativeSourceUrl, type ForecastFrame, type ForecastManifest, type NativeFrame, type WindFrame } from './native-source';
import { windFrames } from './wind-levels';

type Retention = { group: string; cohort: string; keep: readonly string[] };
const cohorts = new WeakMap<ForecastManifest, Map<string, Promise<Retention>>>();

export function convertedReference(baseUrl: string, manifest: ForecastManifest, frame: NativeFrame | WindFrame) {
  const first = 'levels' in frame ? frame.levels[0]! : frame;
  const path = 'records' in first ? first.records[manifest.fields[0]!]!.path : first.path;
  // Preserve existing source-addressed cache keys across the server migration.
  const sourceBase = baseUrl.replace(/\/(?:api\/weather|weather\/awc)\/grids\/$/, '/weather/noaa/');
  return { url: 'records' in first ? nativeSourceUrl(sourceBase, path) : new URL(path, baseUrl).href,
    identity: `packed-v1/${gridKey(manifest, frame)}` };
}

/** One endpoint, source generation and altitude owns a complete hourly timeline.
 * Hash the complete source identities so same-run corrections can replace old
 * bytes, while native catalog freshness checks leave retention unchanged. */
export async function forecastRetention(endpoint: string, manifest: ForecastManifest, frame: ForecastFrame) {
  const altitude = 'windAltitude' in frame ? ['wind', frame.windAltitude] : [frame.altitudeFtMsl, frame.pressureHpa];
  const key = JSON.stringify([endpoint, altitude]);
  let cached = cohorts.get(manifest);
  if (!cached) { cached = new Map(); cohorts.set(manifest, cached); }
  let cohort = cached.get(key);
  if (!cohort) {
    const frames = 'windAltitude' in frame ? windFrames(manifest, frame.windAltitude)
      : manifest.frames.filter(f => f.altitudeFtMsl === frame.altitudeFtMsl && f.pressureHpa === frame.pressureHpa);
    const keep = frames.map(f => pluginFileKey('levels' in f || 'records' in f ? convertedReference(endpoint, manifest, f)
      : { url: new URL(f.path, endpoint).href, identity: `grid-v1/${gridKey(manifest, f)}`, byteLength: f.bytes })).sort();
    const identity = JSON.stringify([key, keep]);
    cohort = crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)).then(bytes => ({ group: manifest.product, keep,
      cohort: [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('') }));
    cached.set(key, cohort);
    // Wind source keys contain every eligible pressure record. Keep only a few
    // recent timelines, rather than retaining those long strings at all altitudes.
    if (cached.size > 4) cached.delete(cached.keys().next().value!);
  }
  return cohort;
}
