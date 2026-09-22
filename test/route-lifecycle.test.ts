import { routeDraftFromText } from '@zlayer/domain';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import type { CatalogResponse, ChartRecord } from '@zlayer/contracts';
import { Hooks, hookModule } from './helpers/hooks';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { useRoutePlan } = await import('../src/layers/routes/use-plan');
loader.deregister();
const catalog = (url: string): CatalogResponse => ({ schemaVersion: 1, revision: '2026-09-03',
  generatedAt: '2026-09-16T00:00:00Z', charts: [], weather: [], navigation: [{
    id: 'airports', title: 'Airports', url, count: 1, sourceCount: 1, minZoom: 0,
  }] });
const document = (ident: string) => ({ type: 'FeatureCollection', metadata: { effectiveDate: '2026-09-03', source: 'FAA' },
  features: [{ type: 'Feature', id: ident, properties: { ident }, geometry: { type: 'Point', coordinates: [0, 0] } }] });
function setup(t: test.TestContext) {
  const hooks = new Hooks();
  Object.assign(globalThis, { testHooks: hooks });
  const original = globalThis.window;
  const timers: unknown[] = [];
  globalThis.window = Object.assign(new EventTarget(), {
    setTimeout: (...args: unknown[]) => { timers.push(args); return 1; }, clearTimeout() {},
  }) as unknown as Window & typeof globalThis;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  t.after(() => { hooks.unmount(); globalThis.window = original; Reflect.deleteProperty(navigator, 'onLine'); });
  return { hooks, timers };
}

test('GPS routes survive absent, loading and failed navigation data, then resolve missing named points on recovery', async t => {
  const { hooks, timers } = setup(t);
  let available = false;
  t.mock.method(globalThis, 'fetch', async () => available
    ? Response.json(document('TEST')) : new Response(null, { status: 503 }));
  let current: CatalogResponse | undefined;
  let draft = routeDraftFromText('350000N1190535W 360000N1200000W');
  const render = () => hooks.render(() => useRoutePlan(current, draft));
  const assertCoordinates = () => {
    const { plan } = render();
    assert.deepEqual(plan.waypoints.map(point => point.ident), ['350000N1190535W', '360000N1200000W']);
    assert.equal(plan.legs.length, 1);
    assert.ok(plan.distanceNm > 60);
    assert.deepEqual(plan.issues, []);
  };
  assertCoordinates();
  current = catalog('https://charts.test/route-gps/airports');
  assert.equal(render().status, 'loading');
  assertCoordinates();
  await tick();
  assert.equal(render().status, 'error');
  assertCoordinates();
  assert.equal(timers.length, 0, 'offline failures do not start a retry loop');

  draft = routeDraftFromText('350000N1190535W TEST 360000N1200000W');
  assert.equal(render().plan.waypoints.length, 2);
  assert.equal(render().plan.legs.length, 0, 'unresolved named points still break connectivity');
  assert.deepEqual(render().plan.unresolved, ['TEST']);
  available = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  render(); await tick();
  const { plan, status } = render();
  assert.equal(status, 'ready');
  assert.deepEqual(plan.waypoints.map(point => point.ident), ['350000N1190535W', 'TEST', '360000N1200000W']);
  assert.equal(plan.legs.length, 2);
  assert.deepEqual(plan.issues, []);
});

test('route resource changes invalidate same-cycle state, while chart coverage does not clip the plan', async t => {
  const { hooks } = setup(t);
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/bad')
    ? new Response(null, { status: 503 }) : Response.json(document('TEST')));
  let current = catalog('https://charts.test/route-life/old');
  const render = () => hooks.render(() => useRoutePlan(current, routeDraftFromText('TEST')));
  render(); await tick(); assert.equal(render().status, 'ready');
  current = catalog('https://charts.test/route-life/bad');
  assert.equal(render().plan.waypoints.length, 0);
  await tick(); assert.equal(render().status, 'error');
  current = catalog('https://charts.test/route-life/old');
  render(); await tick(); assert.equal(render().plan.waypoints.length, 1);
  current = { ...current, charts: [{ bounds: [10, 10, 20, 20] } as ChartRecord] };
  assert.equal(render().plan.waypoints.length, 1);
  await tick(); assert.equal(render().plan.waypoints.length, 1, 'national route points survive coverage changes');
  current = { ...current, navigation: [{ ...current.navigation[0]!, sourceCount: 2 }] };
  assert.equal(render().status, 'loading');
  await tick(); assert.equal(render().status, 'error');
});

test('partial route data warns without dropping cached products or retrying while offline', async t => {
  const { hooks, timers } = setup(t);
  let restored = false;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/fixes') && !restored
    ? new Response(null, { status: 503 }) : Response.json(document('TEST')));
  const current = catalog('https://charts.test/route-partial/airports');
  current.navigation.push({ ...current.navigation[0]!, id: 'fixes', url: 'https://charts.test/route-partial/fixes' });
  const render = () => hooks.render(() => useRoutePlan(current, routeDraftFromText('TEST')));
  render(); await tick();
  assert.equal(render().status, 'partial');
  assert.equal(render().plan.waypoints.length, 1);
  assert.equal(timers.length, 0);
  restored = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  render(); await tick(); assert.equal(render().status, 'ready');
});

test('late responses from replaced route exports cannot overwrite the new resolver', async t => {
  const { hooks } = setup(t);
  let release!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/old')
    ? new Promise<Response>(resolve => { release = resolve; }) : Response.json(document('NEW')));
  let current = catalog('https://charts.test/route-race/old');
  const render = () => hooks.render(() => useRoutePlan(current, routeDraftFromText('NEW')));
  render(); await tick(); current = catalog('https://charts.test/route-race/new');
  render(); await tick(); assert.equal(render().plan.waypoints[0]?.ident, 'NEW');
  release(Response.json(document('OLD'))); await tick();
  assert.equal(render().plan.waypoints[0]?.ident, 'NEW');
});

for (const product of ['terminalProcedures', 'preferredRoutes'] as const) test(`${product} failures report partial data and changed exports invalidate route state`, async t => {
  const { hooks, timers } = setup(t);
  const base = `https://charts.test/${product}-lifecycle`;
  let current = catalog(`${base}/airports`);
  const resource = { title: 'Routes', count: 0, sourceCount: 0, url: `${base}/bad` };
  if (product === 'terminalProcedures') current.terminalProcedures = { ...resource, id: 'terminal-procedures' };
  else current.preferredRoutes = { ...resource, id: 'preferred-routes' };
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/airports') ? Response.json(document('TEST'))
    : String(url).endsWith('/bad') ? new Response(null, { status: 503 }) : Response.json({
      ...(product === 'terminalProcedures' ? { type: 'ZLayerTerminalProcedures', procedures: [] } : { type: 'ZLayerPreferredRoutes', routes: [] }),
      metadata: { effectiveDate: current.revision, source: 'FAA' },
    }));
  const render = () => hooks.render(() => useRoutePlan(current, routeDraftFromText('TEST')));
  render(); await tick();
  assert.equal(render().status, 'partial');
  assert.equal(render().plan.waypoints.length, 1);
  assert.equal(timers.length, 0);
  current = { ...current, [product]: { ...current[product], url: `${base}/good` } };
  assert.equal(render().status, 'loading');
  await tick();
  assert.equal(render().status, 'ready');
});

test('unloading routes releases its loaded resources while preserving the saved draft', async t => {
  const { hooks } = setup(t);
  const source = catalog('https://charts.test/unload-route/airports');
  let current: CatalogResponse | undefined = source;
  const draft = routeDraftFromText('TEST');
  t.mock.method(globalThis, 'fetch', async () => Response.json(document('TEST')));
  const render = () => hooks.render(() => useRoutePlan(current, draft));
  render(); await tick(); assert.equal(render().plan.waypoints.length, 1);
  current = undefined; render(); render();
  current = source;
  assert.equal(render().data.airports, undefined, 'unloaded hook state releases navigation and procedure resources');
  await tick(); assert.equal(render().plan.waypoints.length, 1);
  assert.equal(draft.entries.length, 1);
});
