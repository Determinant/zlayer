import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { ChartRecord } from '@zlayer/contracts';
import { Hooks, hookModule } from './helpers/hooks';

const moduleUrl = (source: string) => 'data:text/javascript,' + encodeURIComponent(source);
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react') return { shortCircuit: true, url: moduleUrl(`
    export * from ${JSON.stringify(hookModule)};
    export const useCallback = (callback, dependencies) => globalThis.testHooks.useMemo(() => callback, dependencies);
  `) };
  if (specifier === '../../pwa') return { shortCircuit: true,
    url: moduleUrl('export const preparePwa = () => globalThis.prepareChartCache();') };
  return next(specifier, context);
} });
const { useChartCache } = await import('../src/layers/charts/use-cache');
loader.deregister();

const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t: test.TestContext, prepare: () => Promise<boolean>) {
  const hooks = new Hooks();
  t.after(() => hooks.unmount());
  const serviceWorker = new EventTarget();
  const globals = { testHooks: hooks, prepareChartCache: prepare,
    navigator: { serviceWorker }, window: new EventTarget() };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let charts: readonly ChartRecord[] | undefined;
  const errors: string[] = [];
  const onError = (message: string) => { errors.push(message); };
  return { hooks, serviceWorker, errors,
    setCharts: (value: readonly ChartRecord[]) => { charts = value; },
    render: () => hooks.render(() => useChartCache(charts, onError)),
  };
}

test('a transient cache startup failure recovers without a reload or browser event', async t => {
  let calls = 0;
  const { render } = setup(t, async () => ++calls > 1);
  assert.equal(render().state, 'preparing');
  await tick();
  assert.equal(render().state, 'preparing');
  t.mock.timers.tick(1_000); await tick();
  assert.equal(render().state, 'ready');
  assert.equal(calls, 2);
  t.mock.timers.tick(60_000); await tick();
  assert.equal(calls, 2, 'successful preparation stops retries');
});

test('persistent startup failures stop retrying and remain manually retryable', async t => {
  let calls = 0, available = false;
  const { render } = setup(t, async () => { calls++; return available; });
  render(); await tick();
  for (const delay of [1_000, 3_000, 10_000]) {
    t.mock.timers.tick(delay); await tick(); render();
  }
  assert.equal(render().state, 'unavailable');
  assert.equal(calls, 4);
  t.mock.timers.tick(60_000); await tick();
  assert.equal(calls, 4, 'persistent failures must not poll indefinitely');
  available = true;
  render().retry(); render(); await tick();
  assert.equal(render().state, 'ready');
});

test('catalog updates keep ready charts visible and use the latest chart error labels', async t => {
  let calls = 0;
  const { render, setCharts, serviceWorker, errors } = setup(t, async () => { calls++; return true; });
  render(); await tick();
  assert.equal(render().state, 'ready');
  setCharts([{ url: 'https://charts.test/sectional.mbtiles', title: 'Updated sectional' } as ChartRecord]);
  render();
  assert.equal(render().state, 'ready', 'changing chart metadata must not hide already enabled charts');
  await tick();
  assert.equal(calls, 1, 'cache readiness is independent of catalog metadata');
  serviceWorker.dispatchEvent(new MessageEvent('message', { data: {
    type: 'chart-archive-error', url: 'https://charts.test/sectional.mbtiles', message: 'Storage full',
  } }));
  assert.deepEqual(errors, ['Updated sectional could not be cached: Storage full']);
});

test('controller changes supersede pending recovery and ignore its stale result', async t => {
  let calls = 0, complete!: (value: boolean) => void;
  const { render, serviceWorker } = setup(t, () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(true);
  });
  render();
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  render(); await tick();
  assert.equal(render().state, 'ready');
  complete(false); await tick();
  t.mock.timers.tick(60_000); await tick();
  assert.equal(render().state, 'ready');
  assert.equal(calls, 2);
});

test('reconnection retries immediately and cancels the previous retry timer', async t => {
  let calls = 0;
  const { render } = setup(t, async () => ++calls > 1);
  render(); await tick();
  window.dispatchEvent(new Event('online'));
  render(); await tick();
  assert.equal(render().state, 'ready');
  t.mock.timers.tick(60_000); await tick();
  assert.equal(calls, 2);
});

for (const event of ['online', 'controllerchange']) {
  test(`${event} keeps ready charts visible while rechecking cache readiness`, async t => {
    let calls = 0, complete!: (value: boolean) => void;
    const { render, serviceWorker } = setup(t, () => ++calls === 1 ? Promise.resolve(true)
      : new Promise(resolve => { complete = resolve; }));
    render(); await tick();
    assert.equal(render().state, 'ready');
    (event === 'online' ? window : serviceWorker).dispatchEvent(new Event(event));
    render();
    assert.equal(render().state, 'ready', 'background checks must not hide working charts');
    assert.equal(calls, 2);
    complete(true); await tick();
    assert.equal(render().state, 'ready');
  });
}

test('browsers without service workers report unavailable without retrying', async t => {
  let calls = 0;
  const { render } = setup(t, async () => { calls++; return false; });
  Reflect.deleteProperty(navigator, 'serviceWorker');
  render(); await tick();
  assert.equal(render().state, 'unavailable');
  t.mock.timers.tick(60_000); await tick();
  assert.equal(calls, 1);
});

test('unmount cancels scheduled startup retries', async t => {
  let calls = 0;
  const { render, hooks } = setup(t, async () => { calls++; return false; });
  render(); await tick();
  hooks.unmount();
  t.mock.timers.tick(60_000); await tick();
  assert.equal(calls, 1);
});
