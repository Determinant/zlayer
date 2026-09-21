import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { cacheProcedureDocument, loadProcedureDocument, procedureFetchUrl,
  type ProcedureDownloadProgress } from '../src/layers/plates/document-cache';
import { PDF_CACHE, VERIFIED_SHA256_HEADER } from '../src/core/storage/cache-names';
import { procedurePageIndex } from '../src/layers/plates/page-target';
import type { ProcedureDocument } from '../src/layers/plates/data';
import { cacheFixture as sharedCacheFixture } from './helpers/cache';
import { ResourceError } from '../src/core/data/errors';
import { fileStorageFixture } from './helpers/file-storage';
import { downloadFile, openFileCache, storeDownloadedFile } from '../src/core/storage/download-file';

const cacheFixture = (t: test.TestContext) => sharedCacheFixture(t, PDF_CACHE);

const bytes = new TextEncoder().encode('%PDF-1.7\nverified test document');
const digest = createHash('sha256').update(bytes).digest('hex');
const source: ProcedureDocument = {
  url: `https://charts.test/tpp-sw2.pdf?sha256=${digest}&bytes=${bytes.length}`,
  nativeUrl: 'https://charts.test/tpp-sw2.pdf#page=3',
  source: 'combined-volume', pageIndex: 2, sha256: digest, byteLength: bytes.length,
};
const pdf = (body: BodyInit = bytes) => new Response(body, { headers: { 'content-type': 'application/pdf' } });
const savedPdf = (body: BodyInit = bytes, sha256 = digest, byteLength = bytes.length) => new Response(body, {
  headers: { 'content-type': 'application/pdf', 'content-length': String(byteLength), [VERIFIED_SHA256_HEADER]: sha256 },
});

test('different viewer books serialize transfers and a failed first book releases the next', async t => {
  cacheFixture(t);
  let started!: () => void, fail!: (error: Error) => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<Response>((_resolve, reject) => { fail = reject; });
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++fetches === 1) { started(); return gate; }
    return pdf();
  });
  const first = loadProcedureDocument(source);
  await beginning;
  const second = loadProcedureDocument({ ...source, url: `${source.url}&book=second` });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1, 'closing/switching viewers must not overlap whole-book downloads');
  const rejected = assert.rejects(first, /Disconnected/);
  fail(new Error('Disconnected'));
  await rejected;
  assert.ok((await second).cached);
  assert.equal(fetches, 2);
});

test('migrating a disk-backed PDF returns the surviving file after removing its old URL', async t => {
  const disk = await fileStorageFixture(t);
  cacheFixture(t);
  const cache = await openFileCache(PDF_CACHE);
  const legacy = source.url.split('?')[0]!;
  const blob = await downloadFile(pdf(), { key: legacy, label: 'Book' });
  await storeDownloadedFile(cache, legacy, blob, {
    'content-type': 'application/pdf', 'content-length': String(bytes.length), [VERIFIED_SHA256_HEADER]: digest,
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline'); });
  const result = await loadProcedureDocument(source);
  assert.equal(await result.blob.text(), new TextDecoder().decode(bytes));
  assert.ok(result.cached);
  assert.equal(await cache.match(legacy), undefined);
  // A prior viewer may still hold the old File after migration removes its URL.
  assert.equal((await disk.files()).length, 1);
  assert.equal(await blob.text(), new TextDecoder().decode(bytes));
  assert.equal(await (await loadProcedureDocument(source)).blob.text(), await result.blob.text());
});

test('PDF HTTP failures expose retryable server errors separately from missing files and full storage', async t => {
  cacheFixture(t);
  for (const [status, code] of [[503, 'request'], [429, 'request'], [404, 'http'], [507, 'storage']] as const) {
    let cancelled = false;
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status }));
    await assert.rejects(cacheProcedureDocument(source), error => error instanceof ResourceError && error.code === code);
    assert.equal(cancelled, true, 'failed HTTP bodies are discarded before retry');
  }
});

test('a bundled PDF is hashed once when saved, then reused across independent page loads', async t => {
  const { stored, cache } = cacheFixture(t);
  const book = new Uint8Array(2 * 1024 * 1024 + 17);
  book.set(bytes);
  const sha256 = createHash('sha256').update(book).digest('hex');
  const bundle = { ...source, url: `https://charts.test/large.pdf?sha256=${sha256}&bytes=${book.length}`,
    sha256, byteLength: book.length };
  const match = t.mock.method(cache, 'match');
  const fetch = t.mock.method(globalThis, 'fetch', async () => pdf(book));
  let hashedBytes = 0;
  const slice = Blob.prototype.slice;
  t.mock.method(Blob.prototype, 'slice', function (this: Blob, start?: number, end?: number, type?: string) {
    const part = slice.call(this, start, end, type);
    if ((end ?? this.size) - (start ?? 0) > 1024) hashedBytes += part.size;
    return part;
  });
  await cacheProcedureDocument(bundle);
  assert.equal(hashedBytes, book.length, 'the initial save verifies the entire book exactly once');
  assert.equal(stored.get(bundle.url)!.headers.get(VERIFIED_SHA256_HEADER), sha256);
  fetch.mock.mockImplementation(async () => { throw new Error('offline'); });
  const readsBefore = match.mock.calls.length;
  for (const pageIndex of [2, 3]) {
    const result = await loadProcedureDocument({ ...bundle, pageIndex });
    assert.ok(result.cached);
    assert.equal(result.blob.size, book.length);
  }
  assert.equal(hashedBytes, book.length, 'subsequent opens do not rescan the book');
  assert.equal(match.mock.calls.length - readsBefore, 2, 'each load reads its persisted response, without relying on a memory cache');
  assert.equal(fetch.mock.calls.length, 1);
});

test('missing or mismatched receipt metadata is verified and upgraded before reuse', async t => {
  const { stored } = cacheFixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const slice = t.mock.method(Blob.prototype, 'slice');
  for (const response of [pdf(), savedPdf(bytes, 'invalid'), savedPdf(bytes, 'a'.repeat(64)),
    savedPdf(bytes, digest, bytes.length + 1)]) {
    stored.set(source.url, response);
    const before = slice.mock.calls.length;
    assert.ok((await loadProcedureDocument(source)).cached);
    assert.ok(slice.mock.calls.slice(before).some(call => call.arguments[1] === 1024 * 1024),
      'untrusted receipt metadata requires hashing the actual bytes');
    assert.equal(stored.get(source.url)!.headers.get(VERIFIED_SHA256_HEADER), digest);
    assert.equal(stored.get(source.url)!.headers.get('content-length'), String(bytes.length));
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test('receipts cannot bypass current book identity, length, or PDF header checks', async t => {
  const { stored } = cacheFixture(t);
  const corrupt = bytes.slice();
  corrupt[corrupt.length - 1]! ^= 1;
  const wrongDigest = createHash('sha256').update(corrupt).digest('hex');
  const fetch = t.mock.method(globalThis, 'fetch', async () => pdf());
  for (const response of [savedPdf(corrupt, wrongDigest), savedPdf(bytes.slice(0, -1)),
    savedPdf(new Uint8Array(bytes.length))]) {
    stored.set(source.url, response);
    const repaired = await loadProcedureDocument(source);
    assert.deepEqual(new Uint8Array(await repaired.blob.arrayBuffer()), bytes);
    assert.ok(repaired.cached);
  }
  assert.equal(fetch.mock.calls.length, 3);
});

test('coalesces whole PDFs, validates before caching, and exposes independently readable blob ranges', async t => {
  const { stored } = cacheFixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, options?: RequestInit) => {
    assert.equal(options?.cache, 'no-store', 'the generic service worker cannot supply an unverified response');
    assert.ok(options?.signal);
    return pdf();
  });
  const [first, second] = await Promise.all([loadProcedureDocument(source), loadProcedureDocument(source)]);
  assert.equal(fetch.mock.calls.length, 1);
  assert.ok(first.cached && second.cached);
  assert.equal(stored.size, 1);
  assert.equal(first.blob, second.blob, 'viewers share the immutable book instead of duplicating its buffer');
  const range = await first.blob.slice(0, 8).arrayBuffer();
  structuredClone(range, { transfer: [range] });
  assert.deepEqual(new Uint8Array(await second.blob.arrayBuffer()), bytes, 'PDF.js range transfers cannot detach the book');
  fetch.mock.mockImplementation(async () => { throw new Error('offline'); });
  const offline = await loadProcedureDocument(source);
  assert.ok(offline.cached);
  assert.deepEqual(new Uint8Array(await offline.blob.arrayBuffer()), bytes);
  assert.equal(fetch.mock.calls.length, 1);
});

test('streamed download progress is shared with late viewers and skipped for saved books', async t => {
  const { stored } = cacheFixture(t);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const fetch = t.mock.method(globalThis, 'fetch', async () => pdf(stream));
  const firstUpdates: ProcedureDownloadProgress[] = [], lateUpdates: ProcedureDownloadProgress[] = [];
  const halfway = Math.floor(bytes.length / 2);
  let firstHalf!: () => void, lateHalf!: () => void;
  const firstReachedHalf = new Promise<void>(resolve => { firstHalf = resolve; });
  const lateReachedHalf = new Promise<void>(resolve => { lateHalf = resolve; });
  const first = loadProcedureDocument(source, progress => {
    firstUpdates.push(progress);
    if (progress.loaded === halfway) firstHalf();
  });
  controller.enqueue(bytes.slice(0, halfway));
  await firstReachedHalf;
  assert.equal(stored.size, 0, 'partial downloads must not be saved');
  const late = loadProcedureDocument({ ...source, pageIndex: 3 }, progress => {
    lateUpdates.push(progress);
    if (progress.loaded === halfway) lateHalf();
  });
  await lateReachedHalf;
  assert.deepEqual(lateUpdates[0], { phase: 'downloading', loaded: halfway, total: bytes.length });
  controller.enqueue(bytes.slice(halfway));
  controller.close();
  const [a, b] = await Promise.all([first, late]);
  assert.equal(a.blob, b.blob);
  assert.equal(fetch.mock.calls.length, 1);
  assert.deepEqual(firstUpdates[0], { phase: 'downloading', loaded: 0, total: bytes.length });
  for (const updates of [firstUpdates, lateUpdates]) {
    assert.deepEqual(updates.at(-1), { phase: 'preparing', loaded: bytes.length, total: bytes.length });
    assert.ok(updates.every((update, index) => update.loaded >= (updates[index - 1]?.loaded ?? 0)));
  }
  const cachedUpdates: ProcedureDownloadProgress[] = [];
  assert.ok((await loadProcedureDocument(source, progress => cachedUpdates.push(progress))).cached);
  assert.deepEqual(cachedUpdates, [], 'opening another saved page must not claim to download again');
});

test('download totals prefer catalog bytes and never confuse encoded lengths with PDF bytes', async t => {
  const { stored } = cacheFixture(t);
  const fallback: ProcedureDocument = {
    url: source.url, nativeUrl: source.nativeUrl, pageIndex: 0, source: 'faa-individual',
  };
  for (const [document, headers, total] of [
    [source, { 'content-length': '12', 'content-encoding': 'gzip' }, bytes.length],
    [fallback, { 'content-length': String(bytes.length) }, bytes.length],
    [fallback, {}, undefined],
    [fallback, { 'content-length': '12', 'content-encoding': 'gzip' }, undefined],
  ] as const) {
    stored.clear();
    t.mock.method(globalThis, 'fetch', async () => new Response(bytes, {
      headers: { 'content-type': 'application/pdf', ...headers },
    }));
    const updates: ProcedureDownloadProgress[] = [];
    await loadProcedureDocument(document, progress => updates.push(progress));
    assert.equal(updates.filter(update => update.phase === 'downloading').at(-1)?.total, total);
    assert.deepEqual(updates.at(-1), { phase: 'preparing', loaded: bytes.length, total: bytes.length });
  }
});

test('an interrupted download never reports preparation or saves partial bytes and can retry', async t => {
  const { stored } = cacheFixture(t);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const fetch = t.mock.method(globalThis, 'fetch', async () => pdf(stream));
  const updates: ProcedureDownloadProgress[] = [];
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  const loading = loadProcedureDocument(source, progress => {
    updates.push(progress);
    if (progress.loaded > 0) received();
  });
  controller.enqueue(bytes.slice(0, 10));
  await started;
  controller.error(new TypeError('connection interrupted'));
  await assert.rejects(loading, /connection interrupted/);
  assert.ok(updates.every(update => update.phase === 'downloading'));
  assert.equal(stored.size, 0);
  fetch.mock.mockImplementation(async () => pdf());
  const retry: ProcedureDownloadProgress[] = [];
  assert.ok((await loadProcedureDocument(source, progress => retry.push(progress))).cached);
  assert.equal(retry[0]!.loaded, 0);
});

test('rejects wrong hashes even for equal-length PDFs; repairs corrupt persisted entries', async t => {
  const { stored } = cacheFixture(t);
  const corrupt = bytes.slice();
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  stored.set(source.url, pdf(corrupt));
  const fetch = t.mock.method(globalThis, 'fetch', async () => pdf());
  assert.ok((await loadProcedureDocument(source)).cached);
  assert.equal(fetch.mock.calls.length, 1);
  stored.clear();
  fetch.mock.mockImplementation(async () => savedPdf(corrupt));
  await assert.rejects(loadProcedureDocument(source), /SHA-256 mismatch/);
  assert.equal(stored.size, 0);
  fetch.mock.mockImplementation(async () => pdf(bytes.slice(0, -1)));
  await assert.rejects(loadProcedureDocument(source), /size mismatch/);
  fetch.mock.mockImplementation(async () => new Response('<html>not a PDF</html>'));
  await assert.rejects(loadProcedureDocument(source), /not a complete PDF/);
  fetch.mock.mockImplementation(async () => pdf());
  assert.ok((await loadProcedureDocument(source)).cached, 'a failed load must be retryable');
});

test('quota failure permits verified online viewing without claiming offline availability', async t => {
  const { cache } = cacheFixture(t);
  t.mock.method(cache, 'put', async () => { throw new DOMException('full', 'QuotaExceededError'); });
  t.mock.method(globalThis, 'fetch', async () => pdf());
  const result = await loadProcedureDocument(source);
  assert.equal(result.cached, false);
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), bytes);
});

test('temporary cached PDF read failures never delete a saved edition', async t => {
  const { stored, cache } = cacheFixture(t);
  stored.set(source.url, pdf());
  t.mock.method(cache, 'match', async () => {
    const response = pdf();
    response.blob = async () => { throw new DOMException('busy', 'NotReadableError'); };
    return response;
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await assert.rejects(loadProcedureDocument(source), /offline/);
  assert.ok(stored.has(source.url));
});

test('a transient read failure cannot migrate an unversioned book onto itself and delete it', async t => {
  const { stored, cache } = cacheFixture(t);
  const unversioned = { ...source, url: source.url.split('?')[0]! };
  stored.set(unversioned.url, savedPdf());
  const match = cache.match;
  let failOnce = true;
  t.mock.method(cache, 'match', async (key: RequestInfo | URL) => {
    const response = await match(key);
    if (response && failOnce) {
      failOnce = false;
      response.blob = async () => { throw new DOMException('busy', 'NotReadableError'); };
    }
    return response;
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await assert.rejects(loadProcedureDocument(unversioned), /offline/);
  assert.ok(stored.has(unversioned.url));
  assert.ok((await loadProcedureDocument(unversioned)).cached, 'the saved copy remains readable on retry');
});

test('preserves previously cached unversioned books only after verifying the current identity', async t => {
  const { stored } = cacheFixture(t);
  const legacy = source.url.split('?')[0]!;
  stored.set(legacy, pdf());
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  assert.ok((await loadProcedureDocument(source)).cached);
  assert.equal(fetch.mock.calls.length, 0);
  assert.equal(stored.get(source.url)?.headers.get(VERIFIED_SHA256_HEADER), digest);
  assert.equal(stored.has(legacy), false, 'migration leaves only one whole-file entry');
  stored.delete(source.url);
  stored.set(legacy, pdf('%PDF-1.7\nan older book'));
  await assert.rejects(loadProcedureDocument(source), /offline/);
  assert.ok(stored.has(legacy), 'do not delete a different older edition');
});

test('legacy PDF URL migration reuses a matching verified receipt without hashing the book again', async t => {
  const { stored } = cacheFixture(t);
  const legacy = source.url.split('?')[0]!;
  stored.set(legacy, savedPdf());
  const slice = t.mock.method(Blob.prototype, 'slice');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must migrate offline'); });
  assert.ok((await loadProcedureDocument(source)).cached);
  assert.equal(slice.mock.calls.length, 1, 'only the small PDF signature probe is needed');
  assert.equal(slice.mock.calls[0]!.arguments[1], 1024);
  assert.equal(stored.has(legacy), false);
  assert.equal(stored.get(source.url)!.headers.get(VERIFIED_SHA256_HEADER), digest);
});

test('offline saves require durable PDF storage; failed receipt upgrades preserve readable cached books', async t => {
  const { stored, cache } = cacheFixture(t);
  t.mock.method(cache, 'put', async () => { throw new DOMException('full', 'QuotaExceededError'); });
  t.mock.method(globalThis, 'fetch', async () => pdf());
  await assert.rejects(cacheProcedureDocument(source), /could not be saved/);
  stored.set(source.url, pdf());
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.ok((await loadProcedureDocument(source)).cached);
  assert.ok(stored.has(source.url));
});

test('FAA fallbacks use a constrained proxy, retain export identity, and are available offline', async t => {
  const { stored } = cacheFixture(t);
  const url = 'https://aeronav.faa.gov/d-tpp/2609/SW2TO.PDF?v=updated';
  assert.equal(procedureFetchUrl(url), '/faa-procedures/2609/SW2TO.PDF?v=updated');
  assert.equal(procedureFetchUrl(url, 'https://proxy.test/faa/'), 'https://proxy.test/faa/2609/SW2TO.PDF?v=updated');
  for (const other of ['https://elsewhere.test/d-tpp/2609/A.PDF', 'https://aeronav.faa.gov/other/A.PDF']) {
    assert.equal(procedureFetchUrl(other), other);
  }
  const fallback: ProcedureDocument = { url, nativeUrl: url, pageIndex: 0, source: 'faa-individual', namedDestination: '(HWD)' };
  const fetch = t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL) => {
    assert.equal(request, '/faa-procedures/2609/SW2TO.PDF?v=updated');
    return pdf();
  });
  assert.ok((await loadProcedureDocument(fallback)).cached);
  assert.equal(stored.get(url)!.headers.get(VERIFIED_SHA256_HEADER), digest,
    'individual PDFs get a local integrity receipt, not a fictitious publisher checksum');
  fetch.mock.mockImplementation(async () => { throw new Error('offline'); });
  assert.ok((await loadProcedureDocument(fallback)).cached);
  assert.equal(fetch.mock.calls.length, 1);
  stored.set(url, new Response(bytes.slice(0, -1), { headers: stored.get(url)!.headers }));
  await assert.rejects(loadProcedureDocument(fallback), /offline/, 'a truncated individual PDF cannot reuse its stored receipt');
  assert.equal(stored.has(url), false);
});

test('existing auto-cached individual PDFs gain receipts without another fetch', async t => {
  const { stored } = cacheFixture(t);
  const url = 'https://aeronav.faa.gov/d-tpp/2609/HIGH.PDF?v=edition';
  stored.set(url, pdf());
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await cacheProcedureDocument({ url, nativeUrl: url, source: 'faa-individual', pageIndex: 0 });
  assert.equal(stored.get(url)!.headers.get(VERIFIED_SHA256_HEADER), digest);
  assert.equal(fetch.mock.calls.length, 0);
});

test('resolves fallback named destinations and rejects missing/out-of-bounds targets', async () => {
  const document = {
    numPages: 10,
    getDestination: async (name: string) => name === '(HWD)' ? [{ num: 17, gen: 0 }, { name: 'XYZ' }] : null,
    getPageIndex: async (ref: { num: number; gen: number }) => { assert.equal(ref.num, 17); return 7; },
  };
  assert.equal(await procedurePageIndex(document, { pageIndex: 2 }), 2);
  assert.equal(await procedurePageIndex(document, { pageIndex: 0, namedDestination: '(HWD)' }), 7);
  assert.equal(await procedurePageIndex({ ...document, getDestination: async () => [0] }, { pageIndex: 0, namedDestination: 'first' }), 0);
  await assert.rejects(procedurePageIndex(document, { pageIndex: 0, namedDestination: 'missing' }), /destination is missing/);
  await assert.rejects(procedurePageIndex(document, { pageIndex: 10 }), /outside the PDF/);
});
