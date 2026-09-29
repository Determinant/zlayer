import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { expose } from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js';

import { openPackageReader, releasePackageDecoder } from '../src/layers/charts/package-loader.js';
import type { PackageTile } from '../src/layers/charts/package-reader.js';

test('reuses the package worker and retries failures and cancels active/queued work independently', { timeout: 5_000 }, async (t) => {
  const workers: TestWorker[] = [];
  const bytes = new Uint8Array([42]);
  const rows = (): PackageTile[] => [{ z: 0, x: 0, y: 0, data: bytes.slice().buffer }];
  let decode: (bytes: ArrayBuffer) => Promise<PackageTile[]> = async () => rows();
  class TestWorker extends EventTarget {
    readonly channel = new MessageChannel();
    terminated = false;
    constructor() {
      super();
      workers.push(this);
      this.channel.port1.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
      expose({ decode: (value: ArrayBuffer) => decode(value) }, nodeEndpoint(this.channel.port2));
    }
    postMessage(message: unknown, transfer: ArrayBuffer[]) { this.channel.port1.postMessage(message, transfer); }
    terminate() {
      this.terminated = true;
      this.channel.port1.close();
      this.channel.port2.close();
    }
  }
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  t.after(() => {
    releasePackageDecoder();
    workers.forEach(worker => worker.terminate());
    if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
    else Reflect.deleteProperty(globalThis, 'Worker');
  });
  const url = 'https://charts.test/package.mbtiles?bytes=1';
  const tile = { z: 0, x: 0, y: 0 }, signal = new AbortController().signal;
  const readers = await Promise.all(Array.from({ length: 4 }, () => openPackageReader(url)));
  assert.equal(workers.length, 1);
  for (const reader of readers) {
    assert.deepEqual(new Uint8Array(await reader.read(tile, signal) as ArrayBuffer), bytes);
    reader.dispose();
  }
  // Complete GETs only. File coalescing is the surrounding ArchiveReaderPool's job.
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments[0]), Array(4).fill(url));
  assert.ok(fetch.mock.calls.every(call => !call.arguments[1]?.headers), 'decoding never fetches byte ranges');
  await assert.rejects(openPackageReader(url.replace('bytes=1', 'bytes=2')), /size mismatch/);
  assert.equal(workers.length, 1, 'invalid downloads never reach the decoder');

  decode = async () => { throw new Error('WASM unavailable'); };
  await assert.rejects(openPackageReader(url), /WASM unavailable/);
  assert.equal(workers[0]!.terminated, true);
  decode = async () => rows();
  (await openPackageReader(url)).dispose();
  assert.equal(workers.length, 2, 'failed initialization allows a fresh retry');

  let arrived!: () => void;
  const pending = new Promise<void>(resolve => { arrived = resolve; });
  decode = async () => { arrived(); return new Promise(() => {}); };
  const crashed = assert.rejects(openPackageReader(url), /initialize chart package reader/);
  await pending;
  workers[1]!.dispatchEvent(new Event('error'));
  await crashed;
  assert.equal(workers[1]!.terminated, true);
  decode = async () => rows();
  (await openPackageReader(url)).dispose();
  assert.equal(workers.length, 3, 'a worker crash also allows a fresh retry');
  releasePackageDecoder(); releasePackageDecoder();
  assert.ok(workers.every(worker => worker.terminated), 'unload releases the idle decoder');
  (await openPackageReader(url)).dispose();
  assert.equal(workers.length, 4, 'reload constructs a fresh decoder');
  const active = new AbortController(), queued = new AbortController();
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  decode = async () => { started(); return new Promise(() => {}); };
  const cancelledActive = assert.rejects(openPackageReader(url, active.signal), { name: 'AbortError' });
  await startedPromise;
  const cancelledQueued = assert.rejects(openPackageReader(url, queued.signal), { name: 'AbortError' });
  const healthy = openPackageReader(url);
  queued.abort();
  decode = async () => rows();
  active.abort();
  await Promise.all([cancelledActive, cancelledQueued]);
  (await healthy).dispose();
  assert.equal(workers[3]!.terminated, true, 'active cancellation terminates CPU work');
  assert.equal(workers.length, 5, 'queued live work gets one replacement decoder');
  const controller = new AbortController();
  let resolveFetch!: (response: Response) => void;
  fetch.mock.mockImplementation(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
  const obsolete = assert.rejects(openPackageReader(url, controller.signal), { name: 'AbortError' });
  controller.abort(); releasePackageDecoder();
  resolveFetch(new Response(bytes));
  await obsolete;
  assert.equal(workers.length, 5, 'a stale completed fetch cannot restart a decoder after unload');
});
