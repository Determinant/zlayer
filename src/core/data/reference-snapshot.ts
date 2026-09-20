import { fetchJson } from './fetch-json';
import { jsonIdentity } from './json-identity';
import { referenceGuard, type ReferenceResource } from './references';

type JsonReference = Exclude<ReferenceResource, { id: 'chart-supplements' | 'unverified' }>;

/** Capture the validated export, not its cycle/counts or mutable download location.
 * The digest also namespaces durable storage so two builds can coexist. Retain
 * the original response (including gzip) rather than re-encoding saved bytes. */
export async function captureReference<R extends JsonReference>(resource: R, revision: string, signal?: AbortSignal): Promise<R> {
  const gzip = resource.id === 'route-history' ? { bytes: resource.bytes, uncompressedBytes: resource.uncompressedBytes } : undefined;
  let pinned!: R;
  await fetchJson(resource.url, referenceGuard(resource, revision), 'Regional reference data', {
    requireCache: true, ...(signal ? { signal } : {}), ...(gzip ? { gzip } : {}),
    cacheAs: data => {
      const jsonSha256 = resource.jsonSha256 ?? jsonIdentity(data);
      const url = new URL(resource.url);
      url.searchParams.set('jsonSha256', jsonSha256);
      const { cacheOnly: _legacyPolicy, ...fields } = resource;
      pinned = { ...fields, jsonSha256, url: url.href } as R;
      return pinned.url;
    },
  });
  signal?.throwIfAborted();
  return pinned;
}
