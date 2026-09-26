import { CONVERTER_VERSION, nativeManifest, type ForecastFrame, type ForecastManifest, type SourceFrame, type NativeManifest, type NativeFrame } from './native-source';

// Identical numeric bytes can occur at different valid times or heights. Their
// labels, geometry and source provenance still belong to distinct resources.
const sourceIdentity = (frame: SourceFrame) => 'records' in frame ? frame : { ...frame, sha256: frame.sha256.toLowerCase() };
// Validated catalogs/descriptors are immutable. Avoid serializing every possible
// wind bracket on each renderer/controller update; replacement objects get new keys.
// Keep one complete hourly horizon plus recent selections, not every visited altitude.
const windKeys = new WeakMap<ForecastManifest, Map<ForecastFrame, string>>();
export function gridKey(manifest: ForecastManifest, frame: ForecastFrame): string {
  const wind = 'levels' in frame;
  let keys = windKeys.get(manifest);
  const cached = wind && keys?.get(frame);
  if (cached) return cached;
  // Shared geometry belongs once in the key; every possible vertical bracket
  // still contributes its full source identity, including unrequested levels.
  const identity = wind ? { converter: 'wind-vertical-v2', ...frame, levels: frame.levels.map(sourceIdentity) } : sourceIdentity(frame);
  const key = nativeManifest(manifest) ? JSON.stringify([
    CONVERTER_VERSION, manifest.product, manifest.model, manifest.runTime, manifest.grid, manifest.fields, identity,
  ]) : JSON.stringify([
    manifest.product, manifest.model, manifest.generation, manifest.runTime, manifest.checkedAt, manifest.publishedAt,
    manifest.grid, manifest.fields, identity,
  ]);
  if (wind) {
    if (!keys) { keys = new Map(); windKeys.set(manifest, keys); }
    keys.set(frame, key);
    if (keys.size > 32) keys.delete(keys.keys().next().value!);
  }
  return key;
}

/** Identical in the browser and server; hashing remains environment-owned. */
export function forecastPath(manifest: NativeManifest, frame: NativeFrame, identity: string): string {
  const level = frame.pressureHpa ? `p${frame.pressureHpa}` : frame.altitudeFtMsl ?? 0;
  return `${manifest.product}/${manifest.runTime}-${(frame.validTime - manifest.runTime) / 3600000}-${level}-${identity}.zwp.gz`;
}
