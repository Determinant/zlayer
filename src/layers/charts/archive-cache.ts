import { VERIFIED_SHA256_HEADER } from '../../core/storage/cache-names';
import { readArtifact, verifyBlob } from '../../core/storage/artifacts';
import { httpResourceError, InvalidDataError, ResourceError } from '../../core/data/errors';
import { discardResponseBody } from '../../core/storage/response';
import { verificationReceipt } from '../../core/storage/verification-receipt';
import { downloadFile, storedFileBlob, storeDownloadedFile, discardDownloadedFile } from '../../core/storage/download-file';

export type ChartArchive = { blob: Blob; headers: Headers };

type ChartCache = Pick<Cache, 'delete' | 'match' | 'put'>;
type ArchiveFetcher = (request: Request) => Promise<Response>;
type ArchiveErrorHandler = (error: Error) => void;

const DEFAULT_RESIDENT_ARCHIVES = 6;
const DEFAULT_CONCURRENT_DOWNLOADS = 4;
const SMALL_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_RESIDENT_BYTES = 16 * 1024 * 1024;

export class WholeFileChartCache {
  readonly #requests = new Map<string, Promise<ChartArchive>>();
  readonly #ready = new Map<string, number>();
  #residentBytes = 0;
  readonly #fetchArchive: ArchiveFetcher;
  readonly #maximumResidentArchives: number;
  readonly #maximumConcurrentDownloads: number;
  readonly #downloadQueue: Array<{ slots: number; start: () => void }> = [];
  #activeDownloads = 0;

  constructor(
    fetchArchive: ArchiveFetcher = (request) => fetch(request),
    maximumResidentArchives = DEFAULT_RESIDENT_ARCHIVES,
    maximumConcurrentDownloads = DEFAULT_CONCURRENT_DOWNLOADS,
  ) {
    if (!Number.isSafeInteger(maximumResidentArchives) || maximumResidentArchives < 1) {
      throw new Error('maximumResidentArchives must be a positive integer');
    }
    if (!Number.isSafeInteger(maximumConcurrentDownloads) || maximumConcurrentDownloads < 1) {
      throw new Error('maximumConcurrentDownloads must be a positive integer');
    }
    this.#fetchArchive = fetchArchive;
    this.#maximumResidentArchives = maximumResidentArchives;
    this.#maximumConcurrentDownloads = maximumConcurrentDownloads;
  }

  load(
    cache: ChartCache,
    key: Request,
    onError?: ArchiveErrorHandler,
  ): Promise<ChartArchive> {
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
        onError?.(error instanceof Error ? error : new Error('Unable to cache chart archive'));
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
  async ensureStored(cache: ChartCache, key: Request, onError?: ArchiveErrorHandler): Promise<ChartArchive> {
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

  async #load(cache: ChartCache, key: Request): Promise<ChartArchive> {
    const identity = archiveIdentity(key.url);
    const inspect = () => readArtifact(cache, key, async response => {
      const archive = await archiveFrom(response);
      if (
        response.status === 200 && archive.blob.size === identity.byteLength &&
        verificationReceipt(archive.headers, identity)
      ) {
        return archive;
      }
      throw new InvalidDataError('Stored chart archive identity mismatch');
    });
    let stored = await inspect();
    // Reopen a stale file handle once. If it remains unreadable, repair with a
    // verified network copy without deleting the previous entry first.
    if (stored.state === 'unavailable' && isUnreadableFile(stored.error)) stored = await inspect();
    if (stored.state === 'ready') return stored.value;
    if (stored.state === 'invalid') await cache.delete(key);
    if (stored.state === 'unavailable' && !isUnreadableFile(stored.error)) throw new ResourceError('storage',
      stored.error instanceof Error ? stored.error.message : 'Chart storage unavailable', { cause: stored.error });

    // The MBTiles file—not an individual raster tile or SQLite page—is the cache
    // unit. All simultaneous HEAD/range reads await this one download, after which
    // their byte ranges are sliced from the same persistent archive Blob.
    // Bound complete download + hash + storage operations, not individual tile
    // reads. Persisted archives bypass this queue so cached panning stays fast.
    // A large archive uses the entire transfer budget, including hash + commit.
    // Small spatial packages can still fill four network slots.
    const slots = identity.byteLength > SMALL_ARCHIVE_BYTES
      ? this.#maximumConcurrentDownloads : 1;
    if (this.#downloadQueue.length || this.#activeDownloads + slots > this.#maximumConcurrentDownloads) {
      await new Promise<void>((start) => this.#downloadQueue.push({ slots, start }));
    } else {
      this.#activeDownloads += slots;
    }
    try {
      const response = await this.#fetchArchive(new Request(key, { signal: AbortSignal.timeout(120_000) })).catch(cause => {
        throw new ResourceError('request', cause instanceof Error ? cause.message : 'Chart request failed', { cause });
      });
      if (response.status !== 200 || response.type === 'opaque') {
        discardResponseBody(response);
        throw httpResourceError(response.status, `Unable to cache chart archive: ${response.status}`);
      }
      const blob = await downloadFile(response, { ...identity, key, label: 'Chart archive' });
      const archive = archiveWithBlob(response, blob);
      try {
        await verifyBlob(blob, identity, 'Chart archive');
        archive.headers.set(VERIFIED_SHA256_HEADER, identity.sha256);
        archive.blob = await storeDownloadedFile(cache, key, blob, archive.headers);
        return archive;
      } finally { await discardDownloadedFile(blob); }
    } finally {
      this.#activeDownloads -= slots;
      while (this.#downloadQueue[0] &&
        this.#activeDownloads + this.#downloadQueue[0].slots <= this.#maximumConcurrentDownloads) {
        const next = this.#downloadQueue.shift()!;
        this.#activeDownloads += next.slots;
        next.start();
      }
    }
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
    throw new Error('Chart archive URL is missing a valid content identity');
  }
  return { byteLength, sha256: sha256Values[0]! };
}

async function archiveFrom(response: Response): Promise<ChartArchive> {
  const blob = await storedFileBlob(response);
  return archiveWithBlob(response, blob);
}

function archiveWithBlob(response: Response, blob: Blob): ChartArchive {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-range');
  headers.delete('transfer-encoding');
  headers.set('accept-ranges', 'bytes');
  headers.set('content-length', String(blob.size));
  return { blob, headers };
}
