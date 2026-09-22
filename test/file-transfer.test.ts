import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { transferFile, readManagedFile } from '../src/core/storage/file-transfer';
import { WholeFileCache } from '../src/core/storage/archive-cache';
import { loadProcedureDocument } from '../src/layers/plates/document-cache';
import { fileStorageFixture } from './helpers/file-storage';
import { cacheFixture } from './helpers/cache';
import { DOWNLOAD_WRITE_BYTES } from '../src/core/storage/download-file';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('chart acquisitions and PDF adapters share core slots through publication', async t => {
  cacheFixture(t);
  const body = new Uint8Array([1]), hash = createHash('sha256').update(body).digest('hex');
  const chart = new WholeFileCache(async () => new Response(body));
  const stored = gate(), entered = gate();
  const cache = { match: async () => undefined, delete: async () => false,
    put: async () => { entered.resolve(); await stored.promise; } };
  const reading = chart.load(cache, new Request(`https://test/chart.mbtiles?bytes=1&sha256=${hash}`));
  await entered.promise;
  const pdfBody = '%PDF-1.7\ntest';
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(pdfBody, { headers: { 'content-type': 'application/pdf' } }));
  const document = loadProcedureDocument({ source: 'faa-individual', url: 'https://test/book.pdf',
    nativeUrl: 'https://test/book.pdf', pageIndex: 0, byteLength: pdfBody.length });
  await turn();
  assert.equal(fetch.mock.callCount(), 0, 'a document waits while the chart is still publishing');
  stored.resolve(); await reading;
  assert.equal((await document).cached, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test('canceling a queued exclusive file lets small work use the remaining slots', async t => {
  const hold = gate(), entered = gate();
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1])));
  const current = transferFile({ url: 'https://test/active', label: 'Active', byteLength: 1 }, async () => {
    entered.resolve(); await hold.promise;
  });
  await entered.promise;
  const controller = new AbortController();
  const canceled = assert.rejects(transferFile({ url: 'https://test/obsolete', label: 'Obsolete', signal: controller.signal,
    exclusive: true }, async () => assert.fail('obsolete consumer')), { name: 'AbortError' });
  let finished = false;
  const next = transferFile({ url: 'https://test/next', label: 'Next', byteLength: 1 }, async () => { finished = true; });
  await turn(); assert.equal(finished, false);
  controller.abort(); await canceled; await next;
  assert.equal(finished, true, 'canceling the head does not strand available capacity');
  hold.resolve(); await current;
});

test('failed validation removes an uncommitted large file and releases the shared budget', async t => {
  const disk = await fileStorageFixture(t);
  cacheFixture(t);
  const bytes = new Uint8Array(9 * 1024 * 1024);
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  await assert.rejects(transferFile({ url: 'https://test/invalid.bin', label: 'File', byteLength: bytes.length },
    async () => { throw new Error('format rejected'); }), /format rejected/);
  assert.deepEqual(await disk.files(), []);
  assert.ok(disk.fixture.writes.every(bytes => bytes <= DOWNLOAD_WRITE_BYTES));
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  assert.equal(await transferFile({ url: 'https://test/next.bin', label: 'Next', byteLength: 2 }, async ({ blob }) => blob.text()), 'ok');
});

test('managed archive reads reject oversized bodies without whole-response buffering', async t => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32)); }, cancel() { cancelled = true; },
  }));
  response.arrayBuffer = async () => assert.fail('unbounded response arrayBuffer');
  response.blob = async () => assert.fail('unbounded response blob');
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(readManagedFile('https://test/package', { byteLength: 16, maximumBytes: 16,
    label: 'Package', responseError: () => new Error('network') }), /byte limit|size mismatch/);
  assert.equal(cancelled, true);
});
