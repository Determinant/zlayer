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

test('a slow response with only a maximum size leaves room for ready files', async t => {
  const headers = gate(), entered = gate();
  const fetches: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    fetches.push(url);
    if (url.endsWith('/slow')) { entered.resolve(); await headers.promise; }
    return new Response('ok', { headers: { 'content-length': '2' } });
  });
  const slow = transferFile({ url: 'https://test/slow', label: 'Slow', maximumBytes: 16 * 1024 * 1024 }, async ({ blob }) => blob.text());
  await entered.promise;
  let finished = false;
  const ready = transferFile({ url: 'https://test/ready', label: 'Ready', maximumBytes: 16 * 1024 * 1024 }, async ({ blob }) => {
    assert.equal(await blob.text(), 'ok'); finished = true;
  });
  try {
    for (let i = 0; i < 10 && !finished; i++) await turn();
    assert.deepEqual(fetches, ['https://test/slow', 'https://test/ready']);
    assert.equal(finished, true, 'ready files complete while the first response still waits for headers');
  } finally { headers.resolve(); await Promise.all([slow, ready]); }
});

test('unknown-size responses upgrade to exclusive body consumption without deadlocking', async t => {
  const headers = gate(), held = gate(), entered = gate();
  const bytes = new Uint8Array(5 * 1024 * 1024);
  let fetched = 0, consuming = 0, peak = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetched++; await headers.promise;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  });
  const jobs = [1, 2].map(n => transferFile({ url: `https://test/${n}`, label: 'Large', maximumBytes: 16 * 1024 * 1024 }, async ({ blob }) => {
    assert.equal(blob.size, bytes.length); consuming++; peak = Math.max(peak, consuming); entered.resolve();
    await held.promise; consuming--;
  }));
  try {
    await turn(); assert.equal(fetched, 2);
    headers.resolve(); await entered.promise; await turn();
    assert.equal(consuming, 1, 'the upgraded reservation covers validation/publication');
  } finally { headers.resolve(); held.resolve(); await Promise.all(jobs); }
  assert.equal(peak, 1);
});

test('canceling a body-budget upgrade cancels its response and frees the queue', async t => {
  const held = gate(), entered = gate(), upgrading = gate();
  let canceled = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!url.endsWith('/upgrade')) return new Response('ok');
    upgrading.resolve();
    return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-length': String(5 * 1024 * 1024) } });
  });
  const active = transferFile({ url: 'https://test/active', label: 'Active', byteLength: 2 }, async () => { entered.resolve(); await held.promise; });
  await entered.promise;
  const controller = new AbortController();
  const upgrade = assert.rejects(transferFile({ url: 'https://test/upgrade', label: 'Upgrade', maximumBytes: 16 * 1024 * 1024,
    signal: controller.signal }, async () => assert.fail('canceled body')), { name: 'AbortError' });
  try {
    await upgrading.promise; await turn(); controller.abort(); await upgrade;
    assert.equal(canceled, true);
    assert.equal(await transferFile({ url: 'https://test/next', label: 'Next', byteLength: 2 }, async ({ blob }) => blob.text()), 'ok');
  } finally { controller.abort(); held.resolve(); await active; }
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
