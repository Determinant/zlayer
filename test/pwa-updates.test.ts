import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { PwaUpdates, pwaUpdates, watchPwaUpdates } from '../src/pwa-updates';

const current = '1111111111111111', next = '2222222222222222';
const versionFor = (release: string) => `v0.1.0+g1234567.b${release.slice(0, 8)}`;

function fixture(t: TestContext, release = current) {
  let reloads = 0, checks = 0;
  const worker = Object.assign(new EventTarget(), {
    state: 'activated', release,
    postMessage(_message: unknown, ports: MessagePort[]) {
      ports[0]!.postMessage({ release: this.release, displayVersion: versionFor(this.release) }); ports[0]!.close();
    },
  });
  const container = Object.assign(new EventTarget(), { controller: worker });
  const registration = Object.assign(new EventTarget(), {
    installing: null as typeof worker | null,
    update: async () => { checks++; },
  });
  const updates = new PwaUpdates({ id: current, version: versionFor(current) }, () => { reloads++; }, 100);
  updates.connect(registration as unknown as ServiceWorkerRegistration, container as unknown as ServiceWorkerContainer);
  t.after(() => updates.disconnect());
  return { updates, registration, worker, container, reloads: () => reloads, checks: () => checks };
}

test('reading a cached release alone never claims that the app is up to date', async t => {
  const { updates } = fixture(t);
  await new Promise<void>(resolve => {
    const unsubscribe = updates.subscribe(() => { unsubscribe(); resolve(); });
  });
  assert.equal(updates.snapshot().checked, false, 'local inspection is not a server update check');
  await updates.check();
  assert.equal(updates.snapshot().checked, true);
});

test('connecting during activation observes its completion even after updatefound was missed', async t => {
  const { updates, worker, registration, container } = fixture(t, next);
  updates.disconnect();
  worker.state = 'activating';
  updates.connect(registration as unknown as ServiceWorkerRegistration, container as unknown as ServiceWorkerContainer);
  worker.state = 'activated';
  worker.dispatchEvent(new Event('statechange'));
  await until(updates, () => updates.snapshot().availableRelease === next);
});

test('a synchronous update failure can be retried', async t => {
  const { updates, registration, checks } = fixture(t);
  const update = registration.update;
  registration.update = () => { throw new Error('Registration no longer active'); };
  await updates.check();
  assert.match(updates.snapshot().error!, /Could not check/);
  registration.update = update;
  await updates.check();
  assert.equal(checks(), 1);
  assert.equal(updates.snapshot().error, undefined);
});

test('an abandoned check cannot block a replacement registration or overwrite its result', async t => {
  const { updates, registration, container } = fixture(t);
  let reject!: (reason: unknown) => void;
  registration.update = () => new Promise<void>((_resolve, fail) => { reject = fail; });
  const previous = updates.check();
  await new Promise(resolve => setImmediate(resolve));
  updates.disconnect();
  let checks = 0;
  const replacement = Object.assign(new EventTarget(), { installing: null, update: async () => { checks++; } });
  updates.connect(replacement as unknown as ServiceWorkerRegistration, container as unknown as ServiceWorkerContainer);
  const current = updates.check();
  assert.notEqual(current, previous);
  await current;
  assert.equal(checks, 1);
  reject(new Error('Late failure from the previous registration'));
  await previous;
  assert.equal(updates.snapshot().error, undefined);
  assert.equal(updates.snapshot().checking, false);
});

test('a manual check reports an unresponsive release handshake rather than silently succeeding', async t => {
  const { updates, worker } = fixture(t);
  await updates.check();
  worker.postMessage = (_message, ports) => { ports[0]!.close(); };
  await updates.check();
  assert.equal(updates.snapshot().checked, false);
  assert.match(updates.snapshot().error!, /confirm the installed release/);
});

async function until(updates: PwaUpdates, predicate: () => boolean) {
  if (predicate()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Update state timed out')); }, 1000);
    const unsubscribe = updates.subscribe(() => {
      if (predicate()) { clearTimeout(timeout); unsubscribe(); resolve(); }
    });
  });
}

test('first install is quiet; a newly controlling release prompts without reloading', async t => {
  const { updates, worker, container, reloads } = fixture(t);
  await updates.check();
  assert.equal(updates.snapshot().availableRelease, undefined);
  worker.release = next;
  container.dispatchEvent(new Event('controllerchange'));
  await until(updates, () => updates.snapshot().availableRelease === next);
  assert.equal(updates.snapshot().currentVersion, versionFor(current));
  assert.equal(updates.snapshot().availableVersion, versionFor(next));
  assert.equal(reloads(), 0);
  updates.dismiss();
  await updates.check();
  assert.equal(updates.snapshot().dismissed, true, 'rechecking the same release respects Later');
  worker.release = '3333333333333333';
  container.dispatchEvent(new Event('controllerchange'));
  await until(updates, () => updates.snapshot().availableRelease === worker.release);
  assert.equal(updates.snapshot().dismissed, false, 'a subsequent release is announced');
  await Promise.all([updates.apply(), updates.apply()]);
  assert.equal(reloads(), 1, 'only an explicit click reloads, and double clicks coalesce');
});

test('truncated display hashes never hide an update or prevent applying it', async t => {
  const collision = '11111111ffffffff';
  const { updates, reloads } = fixture(t, collision);
  await until(updates, () => updates.snapshot().availableRelease === collision);
  assert.equal(updates.snapshot().availableVersion, updates.snapshot().currentVersion);
  await updates.apply();
  assert.equal(reloads(), 1, 'the full internal ID determines whether a release differs');
});

test('legacy workers without a display version remain usable during migration', async t => {
  const { updates, worker, container, reloads } = fixture(t);
  await updates.check();
  worker.release = next;
  worker.postMessage = function (_message, ports) { ports[0]!.postMessage({ release: this.release }); ports[0]!.close(); };
  container.dispatchEvent(new Event('controllerchange'));
  await until(updates, () => updates.snapshot().availableRelease === next);
  assert.equal(updates.snapshot().availableVersion, next);
  await updates.apply();
  assert.equal(reloads(), 1);
});

test('installation must finish and control the page before the update is offered', async t => {
  const { updates, worker, container, registration, reloads } = fixture(t);
  await updates.check();
  const installing = Object.assign(new EventTarget(), {
    state: 'installing', release: next, postMessage: worker.postMessage,
  });
  registration.installing = installing;
  registration.dispatchEvent(new Event('updatefound'));
  assert.equal(updates.snapshot().downloading, true);
  installing.state = 'installed';
  installing.dispatchEvent(new Event('statechange'));
  assert.equal(updates.snapshot().availableRelease, undefined);
  container.controller = installing;
  installing.state = 'activating';
  container.dispatchEvent(new Event('controllerchange'));
  assert.equal(updates.snapshot().availableRelease, undefined);
  installing.state = 'activated';
  installing.dispatchEvent(new Event('statechange'));
  registration.installing = null;
  await until(updates, () => updates.snapshot().availableRelease === next);
  assert.equal(updates.snapshot().downloading, false);
  assert.equal(reloads(), 0);
});

test('an already activated release is found on startup and can be applied offline', async t => {
  const { updates, registration, reloads } = fixture(t, next);
  await until(updates, () => updates.snapshot().availableRelease === next);
  registration.update = async () => { throw new Error('Offline'); };
  await updates.check();
  assert.match(updates.snapshot().error!, /connection/);
  assert.equal(updates.snapshot().availableRelease, next);
  await updates.apply();
  assert.equal(reloads(), 1, 'applying an installed release does not need a network check');
});

test('checks coalesce and a failed download keeps the current app usable', async t => {
  const { updates, registration, worker, reloads } = fixture(t);
  let finish!: () => void;
  registration.update = () => new Promise<void>(resolve => { finish = resolve; });
  const first = updates.check();
  assert.equal(updates.check(), first);
  assert.equal(updates.snapshot().checking, true);
  await new Promise(resolve => setImmediate(resolve));
  finish();
  await first;
  registration.installing = Object.assign(new EventTarget(), { state: 'installing', release: next, postMessage: worker.postMessage });
  registration.dispatchEvent(new Event('updatefound'));
  registration.installing.state = 'redundant';
  registration.installing.dispatchEvent(new Event('statechange'));
  assert.equal(updates.snapshot().downloading, false);
  assert.match(updates.snapshot().error!, /could not be downloaded/);
  assert.equal(updates.snapshot().availableRelease, undefined);
  await updates.apply();
  assert.equal(reloads(), 0);
});

test('an unresponsive worker times out and cannot cause an early reload', async t => {
  const { updates, worker, reloads } = fixture(t, next);
  await until(updates, () => updates.snapshot().availableRelease === next);
  worker.postMessage = (_message, ports) => { ports[0]!.close(); };
  await updates.apply();
  assert.equal(updates.snapshot().applying, false);
  assert.match(updates.snapshot().error!, /not ready/);
  assert.equal(reloads(), 0);
});

test('foreground and reconnection checks are throttled, stop in the background, and clean up', async t => {
  const { registration, container } = fixture(t);
  let checks = 0;
  registration.update = async () => { checks++; };
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget();
  const navigator = { onLine: true, serviceWorker: container };
  for (const [name, value] of Object.entries({ document, window, navigator })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const stop = watchPwaUpdates(registration as unknown as ServiceWorkerRegistration);
  t.after(stop);
  await until(pwaUpdates, () => !pwaUpdates.snapshot().checking);
  assert.equal(checks, 1);
  window.dispatchEvent(new Event('focus'));
  assert.equal(checks, 1);
  now += 60_000;
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(checks, 1);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await until(pwaUpdates, () => !pwaUpdates.snapshot().checking);
  assert.equal(checks, 2);
  window.dispatchEvent(new Event('online'));
  await until(pwaUpdates, () => !pwaUpdates.snapshot().checking);
  assert.equal(checks, 3);
  stop();
  now += 60_000;
  window.dispatchEvent(new Event('focus'));
  assert.equal(checks, 3);
});
