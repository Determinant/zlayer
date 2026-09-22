import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { useRouteResource } = await import('../src/layers/routes/use-resource');
loader.deregister();

function setup(t: test.TestContext) {
  const hooks = new Hooks();
  const previous = globalThis.window;
  const online = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  globalThis.window = new EventTarget() as Window & typeof globalThis;
  Object.assign(globalThis, { testHooks: hooks });
  const setOnline = (value: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, value });
  setOnline(false);
  t.after(() => {
    hooks.unmount();
    globalThis.window = previous;
    if (online) Object.defineProperty(navigator, 'onLine', online);
    else Reflect.deleteProperty(navigator, 'onLine');
  });
  return { hooks, setOnline };
}

test('route resources recover independently on manual retry, reconnect and saved-file repair', async t => {
  const { hooks, setOnline } = setup(t);
  const healthy = { edition: 'healthy' }, repaired = { edition: 'repaired' };
  let available = false, requests = 0;
  const render = () => hooks.render(() => ({
    healthy: useRouteResource('healthy', async () => healthy),
    failed: useRouteResource('failed', async () => {
      requests++;
      if (!available) throw new Error('Offline');
      return repaired;
    }),
  }));
  assert.equal(render().failed.loading, true);
  await tick();
  assert.equal(render().failed.error, 'Offline');
  assert.equal(render().healthy.data, healthy);
  render().failed.retry(); render(); await tick();
  assert.equal(requests, 2);
  assert.equal(render().failed.error, 'Offline');
  setOnline(true); render(); await tick();
  assert.equal(requests, 3, 'reconnect retries failed data without reopening the view');
  available = true;
  window.dispatchEvent(new Event('zlayer-offline-inventory'));
  render(); await tick();
  assert.equal(requests, 4);
  assert.equal(render().failed.data, repaired);
  assert.equal(render().failed.error, undefined);
  assert.equal(render().healthy.data, healthy);
  available = false;
  render().failed.retry();
  assert.equal(render().failed.data, repaired, 'a retry retains the current preview');
  await tick();
  assert.equal(render().failed.data, repaired, 'a failed retry retains validated data from the same source');
  assert.equal(render().failed.error, 'Offline');
  assert.equal(render().failed.loading, false);
});

test('route resource replacement, disabling and unmount reject late results and release requests', async t => {
  const { hooks } = setup(t);
  const requests: Array<{ signal: AbortSignal; resolve: (value: string) => void }> = [];
  let key: string | undefined = 'same-cycle:old-digest';
  const render = () => hooks.render(() => useRouteResource(key, signal =>
    new Promise<string>(resolve => requests.push({ signal, resolve }))));
  render();
  key = 'same-cycle:new-digest'; render();
  assert.equal(requests[0]!.signal.aborted, true);
  requests[1]!.resolve('new'); await tick();
  requests[0]!.resolve('old'); await tick();
  assert.equal(render().data, 'new');
  render().retry(); render();
  key = undefined;
  assert.equal(render().data, undefined);
  assert.equal(render().loading, false);
  assert.equal(requests[2]!.signal.aborted, true);
  requests[2]!.resolve('late'); await tick();
  key = 'same-cycle:new-digest';
  assert.equal(render().data, undefined, 'reactivating starts a new view');
  hooks.unmount();
  assert.equal(requests[3]!.signal.aborted, true);
  requests[3]!.resolve('unmounted'); await tick();
});
