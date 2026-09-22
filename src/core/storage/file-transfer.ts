import { withAbort } from '../data/abort';
import { httpResourceError, ResourceError, resourceErrorCode } from '../data/errors';
import { downloadFile, discardDownloadedFile, DOWNLOAD_MEMORY_LIMIT } from './download-file';
import { discardResponseBody } from './response';

const SMALL_FILE_BYTES = 4 * 1024 * 1024;
const TRANSFER_SLOTS = 4;
type Waiting = { slots: number; start(): void; cancel(): void };
let active = 0;
const waiting: Waiting[] = [];

function drain(): void {
  while (waiting[0] && active + waiting[0].slots <= TRANSFER_SLOTS) {
    const next = waiting.shift()!;
    active += next.slots;
    next.start();
  }
}

function reserve(slots: number, signal?: AbortSignal): (() => void) | Promise<() => void> {
  signal?.throwIfAborted();
  const release = () => { active -= slots; drain(); };
  if (!waiting.length && active + slots <= TRANSFER_SLOTS) { active += slots; return release; }
  return new Promise<void>((resolve, reject) => {
    const task: Waiting = { slots,
      start() { signal?.removeEventListener('abort', task.cancel); resolve(); },
      cancel() {
        const index = waiting.indexOf(task);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal?.reason);
        drain();
      },
    };
    waiting.push(task);
    signal?.addEventListener('abort', task.cancel, { once: true });
    drain();
  }).then(() => release);
}

type FileRequest = {
  url: string;
  key?: RequestInfo | URL;
  label: string;
  byteLength?: number | undefined;
  maximumBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  /** HTTP cache policy; defaults to no-store for explicitly managed files. */
  cache?: RequestCache;
  timeoutMs?: number;
  retries?: number;
  exclusive?: boolean;
  onProgress?: (loaded: number, total: number | undefined) => void;
  fetcher?: (request: Request) => Promise<Response>;
  statusMessage?: (status: number) => string;
  validateResponse?: (response: Response) => void;
};

/** One transfer budget per execution context, shared by every product. The slot
 * covers network, bounded disk writes, validation and publication. Cached reads
 * bypass it; callers must not recursively acquire a transfer from its callback.
 * The callback must consume or publish its file before returning: uncommitted disk
 * files are removed on both success and failure. Small in-memory Blobs may escape. */
export async function transferFile<T>(options: FileRequest,
  consume: (file: { blob: Blob; response: Response }) => Promise<T>): Promise<T> {
  for (const limit of [options.byteLength, options.maximumBytes]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('Invalid file byte limit');
  }
  const bound = options.byteLength ?? options.maximumBytes;
  const reservation = reserve(!options.exclusive && bound !== undefined && bound <= SMALL_FILE_BYTES ? 1 : TRANSFER_SLOTS, options.signal);
  const release = typeof reservation === 'function' ? reservation : await reservation;
  try {
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await requestFile(options, signal);
    let blob: Blob | undefined;
    try {
      signal.throwIfAborted();
      options.validateResponse?.(response);
      const length = options.byteLength ?? ((!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity')
        ? Number(response.headers.get('content-length')) : 0);
      const total = Number.isFinite(length) && length > 0 ? length : undefined;
      options.onProgress?.(0, total);
      blob = await downloadFile(response, { key: options.key ?? options.url, label: options.label,
        byteLength: options.byteLength, maximumBytes: options.maximumBytes,
        ...(options.onProgress ? { onProgress: (loaded: number) => options.onProgress!(loaded, total) } : {}) });
      signal.throwIfAborted();
      return await consume({ blob, response });
    } finally {
      discardResponseBody(response);
      if (blob) await discardDownloadedFile(blob);
    }
  } finally { release(); }
}

async function requestFile(options: FileRequest, signal: AbortSignal): Promise<Response> {
  const init = { cache: options.cache ?? 'no-store', signal };
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const response = options.fetcher
        ? await options.fetcher(new Request(options.url, init))
        : await fetch(options.url, init);
      if (response.status === 200 && response.type !== 'opaque') return response;
      discardResponseBody(response);
      throw httpResourceError(response.status, options.statusMessage?.(response.status)
        ?? `${options.label} unavailable (${response.status})`);
    } catch (error) {
      signal.throwIfAborted();
      if (attempt >= (options.retries ?? 0) || !(error instanceof TypeError || resourceErrorCode(error) === 'request')) {
        if (error instanceof TypeError) throw new ResourceError('request', error.message, { cause: error });
        throw error;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await withAbort(new Promise<void>(resolve => { timer = setTimeout(resolve, 250 * 2 ** attempt); }), signal); }
      finally { clearTimeout(timer); }
    }
  }
}

/** A renderer reading an archive already acquired by the service worker must not
 * schedule another origin transfer. Still bound response consumption before making
 * the decoder's ArrayBuffer, including malformed/misreported responses. */
export async function readManagedFile(url: string, options: {
  byteLength: number; maximumBytes: number; label: string; signal?: AbortSignal | undefined;
  responseError: (response: Response) => Error;
}): Promise<ArrayBuffer> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes > DOWNLOAD_MEMORY_LIMIT ||
    !Number.isSafeInteger(options.byteLength) || options.byteLength <= 0 || options.byteLength > options.maximumBytes) {
    throw new ResourceError('invalid-data', `${options.label} size mismatch`);
  }
  const response = await (options.signal ? fetch(url, { signal: options.signal }) : fetch(url));
  let blob: Blob | undefined;
  try {
    options.signal?.throwIfAborted();
    if (response.status !== 200) throw options.responseError(response);
    blob = await downloadFile(response, { key: url, ...options });
    options.signal?.throwIfAborted();
    return await blob.arrayBuffer();
  } finally {
    discardResponseBody(response);
    if (blob) await discardDownloadedFile(blob);
  }
}
