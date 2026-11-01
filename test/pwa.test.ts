import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
// Update monitoring has its own tests; these exercise readiness and control.
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pwa-updates') return { url: 'data:text/javascript,export const watchPwaUpdates = () => () => {};', shortCircuit: true };
  return next(specifier, context);
} });
const { preparePwa, prepareChartCache, waitForControl } = await import('../src/pwa');
loader.deregister();

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

test('waiting for a specific installation requires that worker to take control', async () => {
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

function installedWorker(t: test.TestContext) {
  const messages: Array<{ requireShell: boolean; port: MessagePort }> = [];
  const worker = { postMessage: (message: { requireShell: boolean }, ports: MessagePort[]) => {
    messages.push({ requireShell: message.requireShell, port: ports[0]! });
  } };
  const registration = { active: worker, installing: null as ServiceWorker | null };
  const container = Object.assign(new EventTarget(), { controller: worker,
    getRegistration: async () => registration,
    register: async () => { assert.fail('an installed app must not register over the network before reading charts'); },
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const document = globalThis.document;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: container } });
  globalThis.document = { readyState: 'complete', querySelector: () => null } as unknown as Document;
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
    globalThis.document = document;
    for (const message of messages) message.port.close();
  });
  return { messages, registration, container };
}

test('an installed offline worker serves charts independently of a failed or pending update', async t => {
  const { messages, registration } = installedWorker(t);
  for (const state of ['installing', 'redundant']) {
    registration.installing = Object.assign(new EventTarget(), { state }) as ServiceWorker;
    const pending = prepareChartCache();
    assert.equal(prepareChartCache(), pending, 'concurrent reads share their preparation');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messages.at(-1)?.requireShell, false);
    messages.at(-1)!.port.postMessage({ ok: true });
    assert.equal(await pending, true);
  }
});

test('saved-chart preparation does not wait for shell repair and successful readiness is checked again', async t => {
  const { messages } = installedWorker(t);
  const shell = preparePwa();
  const chart = prepareChartCache();
  await new Promise(resolve => setImmediate(resolve));
  messages.find(message => !message.requireShell)!.port.postMessage({ ok: true });
  assert.equal(await chart, true);
  messages.find(message => message.requireShell)!.port.postMessage({ error: 'offline' });
  assert.equal(await shell, false, 'explicit saves still require the shell');
  const resumed = prepareChartCache();
  await new Promise(resolve => setImmediate(resolve));
  messages.at(-1)!.port.postMessage({ error: 'reset in progress' });
  assert.equal(await resumed, false, 'an old success must not bypass a later reset');
});

test('a reply from a replaced controller cannot establish readiness for the new worker', async t => {
  const { messages, container } = installedWorker(t);
  const pending = prepareChartCache();
  await new Promise(resolve => setImmediate(resolve));
  container.controller = { postMessage: () => {} };
  messages[0]!.port.postMessage({ ok: true });
  assert.equal(await pending, false);
});
