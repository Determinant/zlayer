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
  const previousDocument = globalThis.document;
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  globalThis.document = visibility as unknown as Document;
  const original = globalThis.window;
  const timers: unknown[] = [];
  globalThis.window = Object.assign(new EventTarget(), {
    setTimeout: (...args: unknown[]) => { timers.push(args); return 1; }, clearTimeout() {},
  }) as unknown as Window & typeof globalThis;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  t.after(() => { hooks.unmount(); globalThis.document = previousDocument; globalThis.window = original; Reflect.deleteProperty(navigator, 'onLine'); });
  return { hooks, timers, visibility };
}

for (const delayed of ['fixes', 'airways', 'terminalProcedures', 'preferredRoutes'] as const) {
  test(`an empty route resolves its first two airports while ${delayed} is still loading`, async t => {
    const { hooks } = setup(t);
    const base = `https://charts.test/route-first-points/${delayed}`;
    const current = catalog(`${base}/airports`);
    current.navigation[0]!.count = current.navigation[0]!.sourceCount = 2;
    const resource = { title: 'Delayed reference', url: `${base}/delayed`, count: 0, sourceCount: 0 };
    if (delayed === 'fixes') current.navigation.push({ ...resource, id: 'fixes', count: 1, sourceCount: 1, minZoom: 0 });
    else if (delayed === 'airways') current.airways = { ...resource, id: 'airways' };
    else if (delayed === 'terminalProcedures') current.terminalProcedures = { ...resource, id: 'terminal-procedures' };
    else current.preferredRoutes = { ...resource, id: 'preferred-routes' };
    const airports = document('FIRST');
    const second = document('SECOND').features[0]!;
    second.geometry.coordinates = [1, 0];
    airports.features.push(second);
    let release!: (response: Response) => void;
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      requests++;
      return String(url).endsWith('/airports') ? Response.json(airports)
        : new Promise<Response>(resolve => { release = resolve; });
    });
    let draft = routeDraftFromText('');
    const render = () => hooks.render(() => useRoutePlan(current, draft));
    assert.equal(render().status, 'idle');
    await tick();
    assert.equal(requests, 0, 'an empty route does not start reference downloads');
    draft = routeDraftFromText('FIRST SECOND');
    render(); await tick();
    try {
      const { plan, status } = render();
      assert.equal(status, 'loading', 'pending reference data remains visible as loading');
      assert.deepEqual(plan.waypoints.map(point => point.ident), ['FIRST', 'SECOND']);
      assert.equal(plan.legs.length, 1, 'available endpoints already have a drawable route leg');
      assert.deepEqual(plan.issues, []);
    } finally {
      const body = delayed === 'fixes' ? document('FIX') : {
        metadata: { effectiveDate: current.revision, source: 'FAA' },
        ...(delayed === 'airways' ? { type: 'ZLayerAirways', airways: [] }
          : delayed === 'terminalProcedures' ? { type: 'ZLayerTerminalProcedures', procedures: [] }
            : { type: 'ZLayerPreferredRoutes', routes: [] }),
      };
      release(Response.json(body));
      await tick();
    }
    assert.equal(render().status, 'ready');
    assert.equal(render().plan.legs.length, 1);
  });
}

test('clearing a partially loaded route ignores late products and a new route can reuse them', async t => {
  const { hooks } = setup(t);
  const current = catalog('https://charts.test/route-clear/airports');
  current.navigation.push({ ...current.navigation[0]!, id: 'fixes', url: 'https://charts.test/route-clear/fixes' });
  let release!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/airports')
    ? Response.json(document('TEST')) : new Promise<Response>(resolve => { release = resolve; }));
  let draft = routeDraftFromText('TEST FIX');
  const render = () => hooks.render(() => useRoutePlan(current, draft));
  render(); await tick();
  assert.equal(render().plan.waypoints[0]?.ident, 'TEST');
  draft = routeDraftFromText('');
  assert.equal(render().status, 'idle');
  release(Response.json(document('FIX'))); await tick();
  assert.deepEqual(render().data, {}, 'late progress cannot retain references after demand stops');
  assert.equal(render().plan.waypoints.length, 0);
  draft = routeDraftFromText('FIX TEST');
  render(); await tick();
  assert.equal(render().status, 'ready');
  assert.deepEqual(render().plan.waypoints.map(point => point.ident), ['FIX', 'TEST']);
});

for (const phase of ['initial', 'error', 'partial'] as const) for (const ambiguous of [false, true]) {
  test(`incremental radial matches wait to persist after ${phase} data (ambiguous: ${ambiguous})`, async t => {
    const { hooks } = setup(t);
    const base = `https://charts.test/route-radial-pending/${phase}/${ambiguous}`;
    const current = catalog(`${base}/airports`);
    if (phase === 'partial') current.navigation.push({ ...current.navigation[0]!, id: 'navaids', url: `${base}/navaids` });
    current.navigation.push({ ...current.navigation[0]!, id: 'fixes', url: `${base}/fixes` });
    let release!: (response: Response) => void;
    let available = phase === 'initial';
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      if (phase === 'partial' && String(url).endsWith('/airports')) return Response.json(document('OTHER'));
      if (!available) return new Response(null, { status: 503 });
      return String(url).endsWith('/fixes') ? new Promise<Response>(resolve => { release = resolve; })
        : Response.json(document('TEST'));
    });
    let draft = routeDraftFromText('TEST/090T/10');
    const render = () => hooks.render(() => useRoutePlan(current, draft, edit => { draft = edit(draft); }));
    render(); await tick();
    if (phase !== 'initial') {
      assert.equal(render().status, phase);
      available = true;
      window.dispatchEvent(new Event('zlayer-offline-inventory'));
      render(); await tick();
      assert.equal(render().status, phase, 'retrying preserves the previous availability warning');
    }
    try {
      assert.equal(render().plan.waypoints.length, 1, 'provisional geometry remains available');
      assert.equal(draft.entries[0]!.radialPosition, undefined, 'do not freeze a match before another source can reveal ambiguity');
    } finally {
      const fixes = document(ambiguous ? 'TEST' : 'OTHER');
      fixes.features[0]!.id = 'fix:delayed';
      fixes.features[0]!.geometry.coordinates = [1, 0];
      release(Response.json(fixes));
      await tick();
    }
    assert.equal(render().status, 'ready');
    if (ambiguous) {
      assert.equal(render().plan.waypoints.length, 0);
      assert.equal(draft.entries[0]!.radialPosition, undefined);
    } else assert.ok(draft.entries[0]!.radialPosition, 'an unambiguous final match is saved');
  });
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


test('route retries back off, pause while hidden, recover on resume and stop after success or unload', async t => {
  const { hooks, timers, visibility } = setup(t);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  const pending = new Map<number, () => void>();
  let timerId = 0;
  window.setTimeout = ((callback: () => void, delay: number) => {
    timers.push(delay); pending.set(++timerId, callback); return timerId;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number | undefined) => { if (id) pending.delete(id); }) as typeof window.clearTimeout;
  let requests = 0, healthyRequests = 0, available = false;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).endsWith('/airports')) { healthyRequests++; return Response.json(document('TEST')); }
    requests++;
    return available ? Response.json(document('FIX')) : new Response(null, { status: 404 });
  });
  let current: CatalogResponse | undefined = catalog('https://charts.test/route-backoff/airports');
  current.navigation.push({ ...current.navigation[0]!, id: 'fixes', url: 'https://charts.test/route-backoff/fixes' });
  const render = () => hooks.render(() => useRoutePlan(current, routeDraftFromText('TEST')));
  render(); await tick();
  for (let i = 0; i < 6; i++) {
    assert.equal(pending.size, 1);
    const [id, callback] = [...pending][0]!; pending.delete(id); callback(); await tick();
  }
  assert.deepEqual(timers, [3000, 6000, 12000, 24000, 48000, 60000, 60000]);
  assert.equal(healthyRequests, 1, 'healthy immutable products are reused across retries');
  visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(pending.size, 0);
  assert.equal(render().status, 'partial');
  const paused = requests;
  await tick(); assert.equal(requests, paused);
  visibility.visibilityState = 'visible'; visibility.dispatchEvent(new Event('visibilitychange')); await tick();
  assert.equal(requests, paused + 1); assert.equal(timers.at(-1), 3000);
  available = true;
  visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange'));
  visibility.visibilityState = 'visible'; visibility.dispatchEvent(new Event('visibilitychange')); await tick();
  assert.equal(render().status, 'ready'); assert.equal(pending.size, 0);
  visibility.dispatchEvent(new Event('visibilitychange')); await tick();
  assert.equal(requests, paused + 2, 'healthy data does not reload on visibility events');
  current = undefined; render();
  visibility.dispatchEvent(new Event('visibilitychange')); await tick();
  assert.equal(pending.size, 0); assert.equal(requests, paused + 2);
});
