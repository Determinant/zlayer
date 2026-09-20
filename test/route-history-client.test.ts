import assert from 'node:assert/strict';
import test from 'node:test';
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
