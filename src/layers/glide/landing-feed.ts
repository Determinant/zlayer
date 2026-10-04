import { isGlideManifest, type GlideManifest, type GlideSource } from '@zlayer/contracts';
import { fetchJson } from '../../core/data/fetch-json';
import { JsonResponseError } from '../../core/data/errors';
import { isLandingManifest, type LandingManifest } from './landing-data';
export const isLandingFeed = (value: unknown): value is GlideManifest | LandingManifest => isGlideManifest(value) || isLandingManifest(value);
export async function fetchGlideSource(root: string, signal?: AbortSignal, fresh = false): Promise<GlideSource | undefined> {
  try {
    const manifest = await fetchJson(`${root}/manifest.json`, isLandingFeed, 'Glide manifest',
      { policy: fresh ? 'network-only' : 'network-first', ...(signal ? { signal } : {}) });
    return 'product' in manifest ? { ...manifest, root } : undefined;
  } catch (error) {
    if (error instanceof JsonResponseError && [404, 410].includes(error.status)) return undefined;
    throw error;
  }
}
