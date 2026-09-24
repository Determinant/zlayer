import { transferFile } from '../../../core/storage/file-transfer';
import { FORECAST_CACHE_BYTES, pluginStorage } from '../storage';
import { gridKey } from './format';
import type { NativeFrame, NativeManifest } from './native-source';
import { terrainKey, terrainPath } from './model-terrain';

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const pressureLevels = pluginStorage.files('pressure-levels', {
  maxEntries: 64, maxBytes: FORECAST_CACHE_BYTES, maxFileBytes: MAX_ARTIFACT_BYTES, maxUnusedMs: 48 * 3600000,
});
const terrain = pluginStorage.files('model-terrain', {
  maxEntries: 4, maxBytes: 32 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024, maxUnusedMs: 48 * 3600000,
});
const digest = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(n => n.toString(16).padStart(2, '0')).join('');

/** Authentication is shared by direct forecasts and cached interpolation inputs. */
export async function preparedSource(baseUrl: string, manifest: NativeManifest, frame: NativeFrame, modelTerrain = false) {
  const identity = await digest(new TextEncoder().encode(modelTerrain ? terrainKey(manifest, frame) : gridKey(manifest, frame)).buffer);
  const level = frame.pressureHpa ? `p${frame.pressureHpa}` : frame.altitudeFtMsl ?? 0;
  const path = modelTerrain ? terrainPath(manifest, identity)
    : `${manifest.product}/${manifest.runTime}-${(frame.validTime - manifest.runTime) / 3600000}-${level}-${identity}.zwp.gz`;
  return { url: new URL(path, baseUrl).href, identity };
}

export function downloadPrepared(source: { url: string; identity: string }, signal: AbortSignal, maximumBytes = MAX_ARTIFACT_BYTES) {
  return transferFile({ url: source.url, label: 'Prepared forecast', maximumBytes, timeoutMs: 45_000, retries: 1, signal,
    validateResponse(response) {
      if (response.headers.get('x-weather-artifact') !== source.identity || !/^[a-f0-9]{64}$/.test(response.headers.get('x-weather-sha256') ?? '')) {
        throw new Error('Prepared forecast identity is missing or mismatched');
      }
    } }, async ({ blob, response }) => {
      const bytes = await blob.arrayBuffer();
      if (await digest(bytes) !== response.headers.get('x-weather-sha256')) throw new Error('Prepared forecast checksum mismatch');
      return bytes;
    });
}

/** Called inside the admitted interpolation job: never reacquire its worker limiter. */
export async function loadWindInput<T>(baseUrl: string, manifest: NativeManifest, frame: NativeFrame, modelTerrain: boolean,
  signal: AbortSignal, online: boolean, validate: (bytes: ArrayBuffer, signal: AbortSignal) => Promise<T>): Promise<T> {
  const source = await preparedSource(baseUrl, manifest, frame, modelTerrain);
  return (modelTerrain ? terrain : pressureLevels).derive({ ...source, label: 'Wind interpolation input', signal, cacheOnly: !online,
    create: signal => downloadPrepared(source, signal, modelTerrain ? 8 * 1024 * 1024 : MAX_ARTIFACT_BYTES), validate });
}
