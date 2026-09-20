import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerClient } from '../src/core/data/worker-client';
import { ArchiveReaderPool } from '../src/layers/charts/reader-pool';

class Endpoint extends EventTarget {
  terminated = 0;
  postMessage() {}
  terminate() { this.terminated++; }
}

for (const event of ['error', 'messageerror']) test(`${event} rejects all pending RPCs and permits reader-pool retry`, async () => {
  const endpoints: Endpoint[] = [];
  const pool = new ArchiveReaderPool(async () => {
    const endpoint = new Endpoint(); endpoints.push(endpoint);
    const client = new WorkerClient<object>(endpoint, 'Reader failed');
    return { client, dispose: () => client.dispose(), isUsable: () => !client.retired };
  }, 1);
  let arrived!: () => void;
  const ready = new Promise<void>(resolve => { arrived = resolve; });
  const first = pool.use('one', ({ client }) => client.call(async () => { arrived(); return new Promise(() => {}); }));
  const second = pool.use('one', ({ client }) => client.call(async () => new Promise(() => {})));
  const rejected = Promise.all([assert.rejects(first, /Reader failed/), assert.rejects(second, /Reader failed/)]);
  await ready;
  const queued = pool.use('two', async () => 'ready');
  endpoints[0]!.dispatchEvent(new Event(event));
  await rejected;
  assert.equal(await queued, 'ready');
  assert.equal(await pool.use('one', async () => 'retried'), 'retried');
  assert.equal(endpoints[0]!.terminated, 1);
});

test('request failure retires a shared worker only after healthy calls settle', async () => {
  const endpoint = new Endpoint();
  const client = new WorkerClient<object>(endpoint, 'Reader failed', { retireOnError: true });
  let finish!: (value: number) => void;
  const shared = client.call(async () => new Promise<number>(resolve => { finish = resolve; }));
  await assert.rejects(client.call(async () => { throw new Error('WASM unavailable'); }), /WASM unavailable/);
  assert.equal(client.retired, true);
  assert.equal(endpoint.terminated, 0);
  await assert.rejects(client.call(async () => 0), /Reader failed/);
  finish(42);
  assert.equal(await shared, 42);
  assert.equal(endpoint.terminated, 1);
});

test('silent workers and explicit disposal settle pending callers', async () => {
  const timed = new WorkerClient<object>(new Endpoint(), 'Reader timed out', { timeoutMs: 10 });
  await assert.rejects(timed.call(async () => new Promise(() => {})), /Reader timed out/);
  const endpoint = new Endpoint();
  const client = new WorkerClient<object>(endpoint, 'Reader closed');
  const pending = assert.rejects(client.call(async () => new Promise(() => {})), /Reader closed/);
  client.dispose(); client.dispose();
  await pending;
  assert.equal(endpoint.terminated, 1);
});
