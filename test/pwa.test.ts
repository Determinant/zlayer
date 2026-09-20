import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePwa, waitForControl } from '../src/pwa';

function workerFixture() {
  const worker = Object.assign(new EventTarget(), { state: 'installing' });
  const container = Object.assign(new EventTarget(), { controller: null as unknown });
  const wait = (timeout = 50) => waitForControl(
    { installing: worker as ServiceWorker }, container as ServiceWorkerContainer, timeout,
  );
  return { worker, container, wait };
}

test('failed installation resolves unavailable instead of waiting for ready forever', async () => {
  const { worker, wait } = workerFixture();
  const pending = wait();
  worker.state = 'redundant';
  worker.dispatchEvent(new Event('statechange'));
  assert.equal(await pending, false);
  assert.equal(await wait(), false, 'already redundant installs fail immediately too');
});

test('waits for control, bounds a stalled activation, and accepts an existing controller', async () => {
  const { container, worker, wait } = workerFixture();
  assert.equal(await wait(5), false);
  const pending = wait();
  worker.state = 'activated';
  container.controller = worker;
  container.dispatchEvent(new Event('controllerchange'));
  assert.equal(await pending, true);
  assert.equal(await wait(), true);
  assert.equal(await waitForControl({ installing: null }, container as ServiceWorkerContainer), true);
});

test('an old controller cannot bypass installation of the new cache policy', async () => {
  const { container, worker, wait } = workerFixture();
  container.controller = {};
  assert.equal(await wait(5), false);
  const pending = wait();
  worker.state = 'activated';
  worker.dispatchEvent(new Event('statechange'));
  container.controller = worker;
  container.dispatchEvent(new Event('controllerchange'));
  assert.equal(await pending, true);
});

test('a failed registration can be retried and concurrent attempts are coalesced', async t => {
  let calls = 0;
  const { worker, container } = workerFixture();
  worker.state = 'redundant';
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: Object.assign(container, {
    register: async () => { calls++; return { installing: worker }; },
  }) } });
  t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : Reflect.deleteProperty(globalThis, 'navigator'));
  const first = preparePwa();
  assert.equal(preparePwa(), first);
  assert.equal(await first, false);
  assert.equal(await preparePwa(), false);
  assert.equal(calls, 2);
});

test('an existing controller must acknowledge writable storage before PWA readiness', async t => {
  let reply!: MessagePort;
  const worker = { postMessage: (_message: unknown, ports: MessagePort[]) => { reply = ports[0]!; } };
  const container = Object.assign(new EventTarget(), {
    controller: worker,
    // An offline registration failure can still use a functioning controller.
    register: async () => { throw new Error('offline'); },
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: container } });
  t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : Reflect.deleteProperty(globalThis, 'navigator'));
  const failed = preparePwa();
  await new Promise(resolve => setImmediate(resolve));
  reply.postMessage({ error: 'Could not rebuild shell' });
  assert.equal(await failed, false, 'a controller does not make a failed preparation successful');
  reply.close();

  let ready = false;
  const pending = preparePwa().then(available => { ready = available; return available; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false, 'readiness waits for the worker even when it already controls the page');
  reply.postMessage({ ok: true });
  assert.equal(await pending, true);
  reply.close();
});
