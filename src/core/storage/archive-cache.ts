import { VERIFIED_SHA256_HEADER } from './cache-names';
import { readArtifact, verifyBlob } from './artifacts';
import { InvalidDataError, ResourceError } from '../data/errors';
import { discardResponseBody } from './response';
import { verificationReceipt } from './verification-receipt';
import { storedFileBlob, storeDownloadedFile } from './download-file';
import { transferFile } from './file-transfer';

export type FileArchive = { blob: Blob; headers: Headers };

type ArchiveCache = Pick<Cache, 'delete' | 'match' | 'put'>;
type ArchiveFetcher = (request: Request) => Promise<Response>;
type ArchiveErrorHandler = (error: Error) => void;

const DEFAULT_RESIDENT_ARCHIVES = 6;
const MAX_RESIDENT_BYTES = 16 * 1024 * 1024;

export class WholeFileCache {
  readonly #requests = new Map<string, Promise<FileArchive>>();
  readonly #ready = new Map<string, number>();
  #residentBytes = 0;
  readonly #fetchArchive: ArchiveFetcher;
  readonly #maximumResidentArchives: number;

  constructor(
    fetchArchive: ArchiveFetcher = (request) => fetch(request),
    maximumResidentArchives = DEFAULT_RESIDENT_ARCHIVES,
  ) {
    if (!Number.isSafeInteger(maximumResidentArchives) || maximumResidentArchives < 1) {
      throw new Error('maximumResidentArchives must be a positive integer');
    }
    this.#fetchArchive = fetchArchive;
    this.#maximumResidentArchives = maximumResidentArchives;
  }

  load(
    cache: ArchiveCache,
    key: Request,
    onError?: ArchiveErrorHandler,
  ): Promise<FileArchive> {
    const cached = this.#requests.get(key.url);
    if (cached) {
      this.#touch(key.url);
      return cached;
    }

    const request = this.#load(cache, key);
    this.#requests.set(key.url, request);
    void request.then(
      (archive) => {
        if (this.#requests.get(key.url) !== request) return;
        this.#ready.set(key.url, archive.blob.size);
        this.#residentBytes += archive.blob.size;
        this.#evictColdArchives();
      },
      (error: unknown) => {
        this.#requests.delete(key.url);
        this.#ready.delete(key.url);
        onError?.(error instanceof Error ? error : new Error('Unable to cache archive'));
      },
    );
    return request;
  }

  #touch(url: string): void {
    const bytes = this.#ready.get(url);
    if (bytes === undefined) return;
    this.#ready.delete(url);
    this.#ready.set(url, bytes);
  }

  /** Explicit saves must restore storage even when a reader still holds the Blob. */
  async ensureStored(cache: ArchiveCache, key: Request, onError?: ArchiveErrorHandler): Promise<FileArchive> {
    const archive = await this.load(cache, key, onError);
    let stored: Response | undefined;
    try { stored = await cache.match(key); }
    catch (error) {
      if (!(error instanceof InvalidDataError) && !isUnreadableFile(error)) throw error;
      this.forget(key.url);
      return this.load(cache, key, onError);
    }
    discardResponseBody(stored);
    if (stored?.status !== 200 || !verificationReceipt(stored.headers, {
      byteLength: archive.blob.size, sha256: archive.headers.get(VERIFIED_SHA256_HEADER)!,
    })) {
      try { await storeDownloadedFile(cache, key, archive.blob, archive.headers); }
      catch (error) {
        // A retained Blob can outlive its readable backing file. Do not reuse
        // that same handle forever when a later save attempts to repair it.
        if (isUnreadableFile(error)) this.forget(key.url);
        throw error;
      }
    }
    return archive;
  }

  forget(url: string): void {
    const bytes = this.#ready.get(url);
    if (bytes === undefined) return; // An active shared download must finish.
    this.#ready.delete(url);
    this.#residentBytes -= bytes;
    this.#requests.delete(url);
  }

  #evictColdArchives(): void {
    while (this.#ready.size > this.#maximumResidentArchives || this.#residentBytes > MAX_RESIDENT_BYTES) {
      const oldest = this.#ready.keys().next().value;
      if (oldest === undefined) return;
      this.forget(oldest);
    }
  }

  async #load(cache: ArchiveCache, key: Request): Promise<FileArchive> {
    const identity = archiveIdentity(key.url);
    const inspect = () => readArtifact(cache, key, async response => {
      const archive = await archiveFrom(response);
      if (
        response.status === 200 && archive.blob.size === identity.byteLength &&
        verificationReceipt(archive.headers, identity)
      ) {
        return archive;
      }
      throw new InvalidDataError('Stored archive identity mismatch');
    });
    let stored = await inspect();
    // Reopen a stale file handle once. If it remains unreadable, repair with a
    // verified network copy without deleting the previous entry first.
    if (stored.state === 'unavailable' && isUnreadableFile(stored.error)) stored = await inspect();
    if (stored.state === 'ready') return stored.value;
    if (stored.state === 'invalid') await cache.delete(key);
    if (stored.state === 'unavailable' && !isUnreadableFile(stored.error)) throw new ResourceError('storage',
      stored.error instanceof Error ? stored.error.message : 'Chart storage unavailable', { cause: stored.error });

    // Persistent cache hits bypass transfer scheduling, keeping warm pans fast.
    return transferFile({ url: key.url, key, ...identity, label: 'Archive', fetcher: this.#fetchArchive,
      statusMessage: status => `Unable to cache archive: ${status}` }, async ({ blob, response }) => {
      const archive = archiveWithBlob(response, blob);
      await verifyBlob(blob, identity, 'Archive');
      archive.headers.set(VERIFIED_SHA256_HEADER, identity.sha256);
      archive.blob = await storeDownloadedFile(cache, key, blob, archive.headers);
      return archive;
    });
  }
}

function isUnreadableFile(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotReadableError';
}

type ArchiveIdentity = { byteLength: number; sha256: string };

function archiveIdentity(url: string): ArchiveIdentity {
  const parameters = new URL(url).searchParams;
  const sha256Values = parameters.getAll('sha256');
  const byteValues = parameters.getAll('bytes');
  const byteLength = Number(byteValues[0]);
  if (
    sha256Values.length !== 1 || !/^[a-f0-9]{64}$/.test(sha256Values[0] ?? '') ||
    byteValues.length !== 1 || !Number.isSafeInteger(byteLength) || byteLength <= 0
  ) {
    throw new Error('Archive URL is missing a valid content identity');
  }
  return { byteLength, sha256: sha256Values[0]! };
}

async function archiveFrom(response: Response): Promise<FileArchive> {
  const blob = await storedFileBlob(response);
  return archiveWithBlob(response, blob);
}

function archiveWithBlob(response: Response, blob: Blob): FileArchive {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-range');
  headers.delete('transfer-encoding');
  headers.set('accept-ranges', 'bytes');
  headers.set('content-length', String(blob.size));
  return { blob, headers };
}
