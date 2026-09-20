import { sha256 } from '@noble/hashes/sha2.js';
import { createSHA256 } from 'hash-wasm';
import { InvalidDataError, ResourceError } from '../data/errors';
import { discardResponseBody } from './response';
import type { ArtifactIdentity } from './verification-receipt';

export type ArtifactRead<T> =
  | { state: 'ready'; value: T }
  | { state: 'missing' }
  | { state: 'invalid'; error: InvalidDataError }
  | { state: 'unavailable'; error: unknown };

/** Inspection never mutates storage. Only an acquisition/repair may replace bytes. */
export async function readArtifact<T>(cache: Pick<Cache, 'match'> | undefined, key: RequestInfo | URL,
  validate: (response: Response) => Promise<T>): Promise<ArtifactRead<T>> {
  if (!cache) return { state: 'unavailable', error: new ResourceError('storage', 'Storage unavailable') };
  let response: Response | undefined;
  try {
    response = await cache.match(key);
    return response ? { state: 'ready', value: await validate(response) } : { state: 'missing' };
  } catch (error) {
    return error instanceof InvalidDataError ? { state: 'invalid', error } : { state: 'unavailable', error };
  } finally { discardResponseBody(response); }
}

let activeHashes = 0;
const waitingHashes: Array<() => void> = [];
const blobDigests = new WeakMap<Blob, Promise<string>>();

/** Blobs are immutable. Share work by the actual byte object, never by URL or
 * expected digest, so a replacement still has to prove its own identity. */
export function blobSha256(blob: Blob): Promise<string> {
  const prior = blobDigests.get(blob);
  if (prior) return prior;
  const request = hashBlob(blob);
  blobDigests.set(blob, request);
  void request.catch(() => { blobDigests.delete(blob); });
  return request;
}

/** Hash a book/archive without making a second, whole-file ArrayBuffer. Bound
 * both each allocation and concurrent verifications in this page/worker. */
async function hashBlob(blob: Blob): Promise<string> {
  if (activeHashes >= 2) await new Promise<void>(resolve => waitingHashes.push(resolve));
  else activeHashes++;
  let hash: Awaited<ReturnType<typeof createSHA256>> | ReturnType<typeof sha256.create> | undefined;
  try {
    // WASM verifies large books/archives without spending seconds in JavaScript
    // compression rounds or making a whole-file allocation.
    // Keep the portable implementation for browsers that cannot instantiate WASM.
    hash = await createSHA256().catch(() => sha256.create());
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
    }
    const digest = hash.digest();
    return typeof digest === 'string' ? digest : Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  } finally {
    if (hash && 'destroy' in hash) hash.destroy();
    const next = waitingHashes.shift();
    if (next) next(); else activeHashes--;
  }
}

export async function verifyBlob(blob: Blob, expected: ArtifactIdentity, label: string): Promise<string> {
  if (expected.byteLength !== undefined && blob.size !== expected.byteLength) {
    throw new InvalidDataError(`${label} size mismatch: expected ${expected.byteLength}, received ${blob.size}`);
  }
  const actual = await blobSha256(blob);
  if (expected.sha256 !== undefined && actual !== expected.sha256.toLowerCase()) {
    throw new InvalidDataError(`${label} SHA-256 mismatch`);
  }
  return actual;
}
