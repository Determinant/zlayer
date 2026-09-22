import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { prepareRouteHistory } from '../src/layers/routes/history/client';
import { resource, revision } from './helpers/route-history';

test('pausing route-history preparation terminates its worker', async t => {
  let started!: () => void;
  const posted = new Promise<void>(resolve => { started = resolve; });
  const workers: TestWorker[] = [];
  class TestWorker extends EventTarget {
    terminated = false;
    constructor() { super(); workers.push(this); }
    postMessage() { started(); }
    terminate() { this.terminated = true; }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else Reflect.deleteProperty(globalThis, 'Worker');
  });

  const controller = new AbortController();
  const request = prepareRouteHistory(resource, revision, controller.signal);
  await posted;
  controller.abort();
  await assert.rejects(request, error => error === controller.signal.reason);
  assert.equal(workers.length, 1);
  assert.equal(workers[0]!.terminated, true);
});

test('history leases preserve another consumer and release idle or cancelled workers on final exit', async t => {
  const { expose } = await import('comlink');
  const { default: nodeEndpoint } = await import('comlink/dist/umd/node-adapter.js');
  const { retainRouteHistory, queryRouteHistory, isRouteHistoryCached } = await import('../src/layers/routes/history/client');
  const workers: TestWorker[] = [];
  let queried!: () => void;
  let block = false;
  class TestWorker extends EventTarget {
    readonly channel = new MessageChannel();
    terminated = false;
    constructor() {
      super(); workers.push(this);
      this.channel.port1.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
      expose({ query: async () => { queried?.(); return block ? new Promise(() => {}) : []; }, cached: async () => true }, nodeEndpoint(this.channel.port2));
    }
    postMessage(message: unknown, transfer: ArrayBuffer[]) { this.channel.port1.postMessage(message, transfer); }
    terminate() { this.terminated = true; this.channel.port1.close(); this.channel.port2.close(); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
  t.after(() => {
    workers.forEach(worker => worker.terminate());
    if (original) Object.defineProperty(globalThis, 'Worker', original); else Reflect.deleteProperty(globalThis, 'Worker');
  });
  const query = { origins: ['KSFO'], destinations: ['KLAX'] };
  const first = retainRouteHistory(), second = retainRouteHistory();
  assert.equal(workers.length, 0, 'leases do not start workers');
  await queryRouteHistory(resource, revision, query);
  first(); first();
  assert.equal(workers[0]!.terminated, false);
  await queryRouteHistory(resource, revision, query);
  assert.equal(workers.length, 1, 'the remaining view reuses its index');
  second();
  assert.equal(workers[0]!.terminated, true);
  assert.equal(await isRouteHistoryCached(resource, revision), true);
  assert.equal(workers[1]!.terminated, true, 'a standalone offline check releases its worker');
  const view = retainRouteHistory(), controller = new AbortController();
  block = true;
  const pending = new Promise<void>(resolve => { queried = resolve; });
  const cancelled = assert.rejects(queryRouteHistory(resource, revision, query, controller.signal), { name: 'AbortError' });
  await pending;
  view();
  assert.equal(workers[2]!.terminated, false, 'an active query owns its own lease');
  controller.abort(); await cancelled;
  assert.equal(workers[2]!.terminated, true, 'cancelling the final query terminates even stalled RPC work');
});
