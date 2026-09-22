import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { downloadFile, openFileCache, storedFileBlob, storeDownloadedFile, discardDownloadedFile,
  removeDownloadFiles, DOWNLOAD_MEMORY_LIMIT, DOWNLOAD_WRITE_BYTES } from '../src/core/storage/download-file';
import { verifyBlob } from '../src/core/storage/artifacts';
import { CHART_CACHE, PDF_CACHE, DATA_CACHE, VERIFIED_SHA256_HEADER, fileReceiptCacheName } from '../src/core/storage/cache-names';
import { cacheFixture } from './helpers/cache';
import { fileStorageFixture } from './helpers/file-storage';
import { cachedFileBytes } from '../src/offline/storage';
import { releaseUnusedFile } from '../src/core/storage/file-lifetime';
import { discardResponseBody } from '../src/core/storage/response';
import { WholeFileChartCache } from '../src/layers/charts/archive-cache';

const key = 'https://charts.test/large.pdf';
const size = 10 * 1024 * 1024 + 123;
function source(byteLength = size) {
  let loaded = 0, cancelled = false, pulls = 0;
  const hash = createHash('sha256');
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (loaded === byteLength) { controller.close(); return; }
      const bytes = new Uint8Array(Math.min(257 * 1024, byteLength - loaded)).fill(pulls % 251);
      loaded += bytes.length;
      hash.update(bytes);
      controller.enqueue(bytes);
    },
    cancel() { cancelled = true; },
  }));
  response.blob = async () => { throw new Error('Whole-response buffering'); };
  response.arrayBuffer = async () => { throw new Error('Whole-response buffering'); };
  return { response, digest: () => hash.digest('hex'), pulls: () => pulls, cancelled: () => cancelled };
}

test('large downloads await bounded disk writes, then publish only a receipt and reopen disk ranges', async t => {
  const disk = await fileStorageFixture(t);
  const { stored } = cacheFixture(t, PDF_CACHE);
  const cache = await openFileCache(PDF_CACHE);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  disk.fixture.beforeWrite = async bytes => {
    assert.equal(bytes.byteOffset, 0);
    assert.equal(bytes.buffer.byteLength, bytes.byteLength, 'WebKit writes must not receive a view into a larger buffer');
    started(); await gate;
  };
  const input = source();
  const progress: number[] = [];
  const loading = downloadFile(input.response, { key, byteLength: size, label: 'Book', onProgress: n => progress.push(n) });
  await waiting;
  assert.ok(input.pulls() <= 2, 'a blocked writer must not drain the network');
  assert.equal(stored.size, 0);
  release();
  const blob = await loading;
  const digest = input.digest();
  assert.equal(blob.size, size);
  assert.equal(await verifyBlob(blob, { sha256: digest, byteLength: size }, 'Book'), digest);
  assert.ok(Math.max(...disk.fixture.writes) <= DOWNLOAD_WRITE_BYTES);
  assert.equal(progress.at(-1), size);
  await storeDownloadedFile(cache, key, blob, {
    'content-length': String(size), 'content-type': 'application/pdf', [VERIFIED_SHA256_HEADER]: digest,
  });
  assert.equal(stored.size, 0, 'old pages must never see a receipt as a whole PDF');
  const receipt = (await (await caches.open(fileReceiptCacheName(PDF_CACHE))).match(key))!;
  assert.equal((await receipt.blob()).size, 0, 'Cache.put must never consume the large payload');
  await discardDownloadedFile(blob);
  assert.equal((await disk.files()).length, 1, 'committed file survives normal release');
  const response = (await cache.match(key))!;
  response.blob = async () => { throw new Error('Do not reassemble a local file through Fetch'); };
  const reopened = await storedFileBlob(response);
  assert.equal(await verifyBlob(reopened, { sha256: digest }, 'Book'), digest);
  assert.equal((await reopened.slice(size - 123).arrayBuffer()).byteLength, 123);
  await cache.delete(key);
  assert.equal((await disk.files()).length, 1, 'open readers retain their backing file after logical removal');
  assert.equal((await reopened.slice(size - 123).arrayBuffer()).byteLength, 123);
  assert.equal(await cache.match(key), undefined);
  await removeDownloadFiles();
  assert.equal((await disk.files()).length, 0, 'full reset removes files after stopping readers');
});

test('missing disk files cannot keep an offline receipt ready', async t => {
  await fileStorageFixture(t); cacheFixture(t, PDF_CACHE);
  const cache = await openFileCache(PDF_CACHE);
  const input = source();
  const blob = await downloadFile(input.response, { key, byteLength: size, label: 'Book' });
  await storeDownloadedFile(cache, key, blob, { 'content-length': String(size) });
  await removeDownloadFiles();
  assert.equal(await cache.match(key), undefined);
  await assert.rejects(storeDownloadedFile(cache, key, blob, {}), { name: 'NotReadableError' });
});

test('truncated local files become incomplete so offline downloads can repair them', async t => {
  const disk = await fileStorageFixture(t); cacheFixture(t, PDF_CACHE);
  const cache = await openFileCache(PDF_CACHE);
  const blob = await downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  const sha256 = await verifyBlob(blob, {}, 'Book');
  await storeDownloadedFile(cache, key, blob, { 'content-length': String(size), [VERIFIED_SHA256_HEADER]: sha256 });
  const directory = await (await disk.storage.getDirectory()).getDirectoryHandle('zlayer-downloads');
  const writer = await (await directory.getFileHandle((await disk.files())[0]!)).createWritable();
  await writer.close();
  assert.equal(await cachedFileBytes({ url: key, byteLength: size, sha256, kind: 'pdf' }), undefined);
});

test('a warm chart reader repairs a truncated durable file without getting stuck on its retained File', async t => {
  const disk = await fileStorageFixture(t); cacheFixture(t, CHART_CACHE);
  const bytes = new Uint8Array(size);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const request = new Request(`https://charts.test/warm.mbtiles?bytes=${size}&sha256=${digest}`);
  const cache = await openFileCache(CHART_CACHE);
  let fetches = 0;
  const archives = new WholeFileChartCache(async () => { fetches++; return new Response(bytes); });
  await archives.ensureStored(cache, request);
  const directory = await (await disk.storage.getDirectory()).getDirectoryHandle('zlayer-downloads');
  const writer = await (await directory.getFileHandle((await disk.files())[0]!)).createWritable();
  await writer.close();
  const repaired = await archives.ensureStored(cache, request);
  assert.equal(fetches, 2);
  assert.equal(await verifyBlob(repaired.blob, { sha256: digest, byteLength: size }, 'Chart'), digest);
  assert.equal(await cachedFileBytes({ url: request.url, kind: 'chart', byteLength: size, sha256: digest }), size);
});

for (const namespace of [PDF_CACHE, DATA_CACHE]) test(`${namespace}: orphan cleanup preserves committed files without opening legacy payloads`, async t => {
  const disk = await fileStorageFixture(t);
  const { cache: native } = cacheFixture(t, namespace);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now - 2 * 86_400_000);
  const old = await downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  const cache = await openFileCache(namespace);
  await storeDownloadedFile(cache, key, old, { 'content-length': String(size) });
  releaseUnusedFile(old); // Receipt ownership must protect it even without a live reader.
  // Simulate a terminated writer, with no surviving reader/transfer lock.
  const directory = await (await disk.storage.getDirectory()).getDirectoryHandle('zlayer-downloads');
  const orphan = `${Date.now()}-${crypto.randomUUID()}-${createHash('sha256').update(`${key}?abandoned`).digest('hex')}`;
  await directory.getFileHandle(orphan, { create: true });
  assert.equal((await disk.files()).length, 2);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(native, 'match', async () => { throw new Error('Cleanup must not open a legacy whole-file body'); });
  const next = await downloadFile(source().response, { key: `${key}?next`, byteLength: size, label: 'Book' });
  assert.equal((await disk.files()).length, 2, 'keeps the committed file, removes the abandoned file, adds the new one');
  assert.equal((await old.slice(0, 4).arrayBuffer()).byteLength, 4);
  await assert.rejects(directory.getFileHandle(orphan), { name: 'NotFoundError' });
  await discardDownloadedFile(next);
});

test('receipt publication preserves complete legacy copies and survives an older page deleting its cache entry', async t => {
  await fileStorageFixture(t);
  const { cache: legacy } = cacheFixture(t, PDF_CACHE);
  const cache = await openFileCache(PDF_CACHE);
  await legacy.put(key, new Response('%PDF-1.7\nlegacy complete book'));
  const blob = await downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  await storeDownloadedFile(cache, key, blob, { 'content-length': String(size) });
  assert.equal(await (await legacy.match(key))!.text(), '%PDF-1.7\nlegacy complete book');
  assert.deepEqual((await cache.keys()).map(request => request.url), [key]);
  await legacy.delete(key); // The previous release only knows this namespace.
  const reopened = (await cache.match(key))!;
  assert.equal((await storedFileBlob(reopened)).size, size);
  discardResponseBody(reopened);
  assert.equal(await legacy.match(key), undefined);
});

test('deleting a legacy whole-file entry never opens its payload', async t => {
  const { cache: legacy, stored } = cacheFixture(t, PDF_CACHE);
  const cache = await openFileCache(PDF_CACHE);
  await legacy.put(key, new Response('%PDF-1.7\nlegacy'));
  t.mock.method(legacy, 'match', async () => { throw new Error('Do not materialize legacy bytes during deletion'); });
  assert.equal(await cache.delete(key), true);
  assert.equal(stored.size, 0);
});

test('concurrent publishers reuse an identical saved file and discard their losing download', async t => {
  const disk = await fileStorageFixture(t); cacheFixture(t, PDF_CACHE);
  const cache = await openFileCache(PDF_CACHE);
  const first = await downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  const second = await downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  const sha256 = await verifyBlob(first, {}, 'Book');
  const headers = { 'content-length': String(size), [VERIFIED_SHA256_HEADER]: sha256 };
  await storeDownloadedFile(cache, key, first, headers);
  const saved = await storeDownloadedFile(cache, key, second, headers);
  await discardDownloadedFile(second);
  assert.equal((await disk.files()).length, 1);
  assert.equal(await verifyBlob(saved, { sha256 }, 'Book'), sha256);
  assert.equal(await verifyBlob(first, { sha256 }, 'Book'), sha256);
});

test('replacement and removal preserve files and slices held by existing readers', async t => {
  await fileStorageFixture(t); cacheFixture(t, PDF_CACHE);
  const cache = await openFileCache(PDF_CACHE);
  const first = await downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  await storeDownloadedFile(cache, key, first, { 'content-length': String(size) });
  const slice = first.slice(0, 4).slice(1);
  const second = await downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  await storeDownloadedFile(cache, key, second, { 'content-length': String(size) });
  assert.deepEqual([...new Uint8Array(await slice.arrayBuffer())], [1, 1, 1]);
  await cache.delete(key);
  assert.equal(await cache.match(key), undefined);
  assert.deepEqual([...new Uint8Array(await first.slice(0, 4).arrayBuffer())], [1, 1, 1, 1]);
  assert.deepEqual([...new Uint8Array(await second.slice(0, 4).arrayBuffer())], [1, 1, 1, 1]);
});

test('failed receipt publication and removal leave the previous saved file usable', async t => {
  const disk = await fileStorageFixture(t); cacheFixture(t, PDF_CACHE);
  const cache = await openFileCache(PDF_CACHE);
  const first = await downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  await storeDownloadedFile(cache, key, first, { 'content-length': String(size) });
  const receipts = await caches.open(fileReceiptCacheName(PDF_CACHE));
  const put = t.mock.method(receipts, 'put', async () => { throw new DOMException('Full', 'QuotaExceededError'); });
  const next = await downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  await assert.rejects(storeDownloadedFile(cache, key, next, { 'content-length': String(size) }), { name: 'QuotaExceededError' });
  await discardDownloadedFile(next);
  put.mock.restore();
  const deletion = t.mock.method(receipts, 'delete', async () => { throw new Error('Storage unavailable'); });
  await assert.rejects(cache.delete(key), /Storage unavailable/);
  deletion.mock.restore();
  const reopened = (await cache.match(key))!;
  assert.equal((await storedFileBlob(reopened)).size, size);
  discardResponseBody(reopened);
  assert.equal((await disk.files()).length, 1);
});

test('orphan reclamation cannot remove a suspended writer even after a day', async t => {
  const disk = await fileStorageFixture(t); cacheFixture(t, PDF_CACHE);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now - 2 * 86_400_000);
  let release!: () => void, started!: () => void, blocked = false;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  disk.fixture.beforeWrite = async () => {
    if (!blocked) { blocked = true; started(); await gate; }
  };
  t.after(release);
  const first = downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  await waiting;
  t.mock.method(Date, 'now', () => now);
  const next = await downloadFile(source().response, { key: `${key}?next`, byteLength: size, label: 'Book' });
  release();
  const finished = await first;
  assert.equal(finished.size, size);
  assert.equal((await disk.files()).length, 2);
  await discardDownloadedFile(finished); await discardDownloadedFile(next);
});

test('failed writes, interrupted bodies, mismatched sizes and uncommitted verification clean up files', async t => {
  const disk = await fileStorageFixture(t); cacheFixture(t, PDF_CACHE);
  disk.fixture.beforeWrite = async () => { throw new DOMException('Full', 'QuotaExceededError'); };
  const input = source();
  await assert.rejects(downloadFile(input.response, { key, byteLength: size, label: 'Book' }), { name: 'QuotaExceededError' });
  assert.equal(input.cancelled(), true);
  assert.equal(disk.fixture.aborts, 1);
  assert.deepEqual(await disk.files(), []);
  disk.fixture.beforeWrite = async () => {};
  const broken = new Response(new ReadableStream({ pull(controller) { controller.error(new Error('Disconnected')); } }));
  await assert.rejects(downloadFile(broken, { key, byteLength: size, label: 'Book' }), /Disconnected/);
  await assert.rejects(downloadFile(source(100).response, { key, byteLength: size, label: 'Book' }), /size mismatch/);
  assert.deepEqual(await disk.files(), []);
  const blob = await downloadFile(source().response, { key, byteLength: size, label: 'Book' });
  await discardDownloadedFile(blob);
  assert.deepEqual(await disk.files(), []);
});

test('unavailable storage rejects known large downloads and caps unknown or dishonest lengths', async () => {
  const known = source();
  await assert.rejects(downloadFile(known.response, { key, byteLength: size, label: 'Book' }), /memory limit/);
  assert.equal(known.cancelled(), true);
  assert.ok(known.pulls() <= 1);
  const unknown = source();
  await assert.rejects(downloadFile(unknown.response, { key, label: 'Book' }), /memory limit/);
  assert.equal(unknown.cancelled(), true);
  const dishonest = source();
  await assert.rejects(downloadFile(dishonest.response, { key, byteLength: 10, label: 'Book' }), /size mismatch/);
  assert.equal(dishonest.cancelled(), true);
  const exact = source(DOWNLOAD_MEMORY_LIMIT);
  const blob = await downloadFile(exact.response, { key, byteLength: DOWNLOAD_MEMORY_LIMIT, label: 'Book' });
  assert.equal(await verifyBlob(blob, { sha256: exact.digest() }, 'Book'), await verifyBlob(blob, {}, 'Book'));
});
