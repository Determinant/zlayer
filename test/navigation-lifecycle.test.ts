import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import type { CatalogResponse, ChartRecord } from '@zlayer/contracts';
import { Hooks, hookModule } from './helpers/hooks';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { useNavigationData } = await import('../src/layers/navigation/use-data');
const { useNavigationSearch } = await import('../src/layers/navigation/use-search');
loader.deregister();
const globals = globalThis as unknown as { testHooks: Hooks; window: unknown };
const visibility = { airports: true, fixes: false, navaids: false, 'vfr-waypoints': false };
const catalog = (url: string): CatalogResponse => ({ schemaVersion: 1, revision: '2026-09-03',
  generatedAt: '2026-09-16T00:00:00Z', charts: [], weather: [], navigation: [{
    id: 'airports', title: 'Airports', url, count: 1, sourceCount: 1, minZoom: 0,
  }] });
const document = (ident: string) => ({ type: 'FeatureCollection', metadata: { effectiveDate: '2026-09-03', source: 'FAA' },
  features: [{ type: 'Feature', id: ident, properties: { ident, name: ident }, geometry: { type: 'Point', coordinates: [0, 0] } }] });

function setup(t: test.TestContext) {
  const hooks = new Hooks();
  globals.testHooks = hooks;
  const original = globals.window;
  globals.window = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
  t.after(() => { hooks.unmount(); globals.window = original; });
  return hooks;
}

test('an old navigation request cannot replace a newer export; coverage is part of identity', async t => {
  const hooks = setup(t);
  let releaseOld!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/old')
    ? new Promise<Response>(resolve => { releaseOld = resolve; }) : Response.json(document('NEW')));
  let current = catalog('https://charts.test/lifecycle/old');
  const render = () => hooks.render(() => useNavigationData(current, visibility));
  render(); await tick();
  current = catalog('https://charts.test/lifecycle/new');
  render(); await tick();
  assert.equal(render().data.airports?.features[0]?.properties.ident, 'NEW');
  releaseOld(Response.json(document('OLD'))); await tick();
  assert.equal(render().data.airports?.features[0]?.properties.ident, 'NEW');
  current = { ...current, charts: [{ bounds: [10, 10, 20, 20] } as ChartRecord] };
  assert.equal(render().data.airports, undefined, 'old coverage is hidden immediately');
  await tick();
  assert.equal(render().data.airports?.features.length, 0, 'the same URL is reprojected for new coverage');
});

test('returning focus keeps ready navigation data stable', async t => {
  const hooks = setup(t);
  const current = catalog('https://charts.test/focus/airports');
  t.mock.method(globalThis, 'fetch', async () => Response.json(document('FOCUS')));
  const render = () => hooks.render(() => useNavigationData(current, visibility));
  render(); await tick();
  const ready = render();
  assert.equal(ready.loadState.airports, 'ready');
  for (let i = 0; i < 3; i++) {
    (globals.window as EventTarget).dispatchEvent(new Event('focus'));
    render(); await tick();
    const after = render();
    assert.equal(after.loadState.airports, 'ready');
    assert.strictEqual(after.data, ready.data, 'focus must not republish map sources');
  }
});

test('search keeps airport matches when another navigation product is unavailable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hooks = setup(t);
  const current = catalog('https://charts.test/search/airports');
  current.navigation.push({ ...current.navigation[0]!, id: 'fixes', url: 'https://charts.test/search/fixes' });
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/fixes')
    ? new Response(null, { status: 503 }) : Response.json(document('KMGM')));
  const render = () => hooks.render(() => useNavigationSearch(current, 'KMGM', undefined));
  render(); t.mock.timers.tick(120); await tick();
  assert.equal(render().results[0]?.feature.properties.ident, 'KMGM');
  assert.deepEqual(render().unavailable, ['fixes']);
  assert.equal(render().loading, false);
});

test('search publishes each ready feed and keeps tied matches in catalog order', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hooks = setup(t);
  const current = catalog('https://charts.test/progressive/airports');
  current.navigation.push({ ...current.navigation[0]!, id: 'fixes', url: 'https://charts.test/progressive/fixes' });
  let release!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/airports')
    ? new Promise<Response>(resolve => { release = resolve; }) : Response.json(document('MATCH')));
  const render = () => hooks.render(() => useNavigationSearch(current, 'MATCH', undefined));
  assert.equal(render().loading, true);
  t.mock.timers.tick(120); await tick();
  assert.deepEqual(render().results.map(result => result.layer), ['fixes']);
  assert.equal(render().loading, true);
  assert.deepEqual(render().unavailable, [], 'pending feeds are not reported as unavailable');
  release(Response.json(document('MATCH'))); await tick();
  assert.deepEqual(render().results.map(result => result.layer), ['airports', 'fixes']);
  assert.equal(render().loading, false);
});

test('pending search responses cannot restore a replaced query or a cleared search', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hooks = setup(t);
  const current = catalog('https://charts.test/pending-search/airports');
  current.navigation.push({ ...current.navigation[0]!, id: 'fixes', url: 'https://charts.test/pending-search/fixes' });
  let release!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/fixes')
    ? new Promise<Response>(resolve => { release = resolve; }) : Response.json(document('MATCH')));
  let query = 'MATCH';
  const render = () => hooks.render(() => useNavigationSearch(current, query, undefined));
  render(); t.mock.timers.tick(120); await tick();
  assert.equal(render().results.length, 1);
  query = 'OTHER';
  assert.deepEqual(render().results, []);
  t.mock.timers.tick(120); await tick();
  assert.deepEqual(render().results, []);
  assert.equal(render().loading, true);
  query = '';
  assert.equal(render().loading, false);
  release(Response.json(document('OTHER'))); await tick();
  assert.deepEqual(render().results, []);
  assert.equal(render().loading, false);
  assert.deepEqual(render().unavailable, []);
});

test('search hides the previous export immediately when its catalog changes with the query unchanged', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hooks = setup(t);
  let release!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/new')
    ? new Promise<Response>(resolve => { release = resolve; }) : Response.json(document('MATCH_OLD')));
  let current = catalog('https://charts.test/search-source/old');
  const render = () => hooks.render(() => useNavigationSearch(current, 'MATCH', undefined));
  render(); t.mock.timers.tick(120); await tick();
  assert.equal(render().results[0]?.feature.id, 'MATCH_OLD');

  current = catalog('https://charts.test/search-source/new');
  assert.deepEqual(render().results, [], 'the old export is not selectable under the new catalog');
  t.mock.timers.tick(120); await tick();
  assert.deepEqual(render().results, [], 'results stay empty while the new export is pending');
  release(Response.json(document('MATCH_NEW'))); await tick();
  assert.equal(render().results[0]?.feature.id, 'MATCH_NEW');

  current = { ...current, charts: [{ bounds: [10, 10, 20, 20] } as ChartRecord] };
  assert.deepEqual(render().results, [], 'a coverage change also invalidates results');
  t.mock.timers.tick(120); await tick();
  assert.deepEqual(render().results, []);
});

test('regional map reads retain healthy data and retry the missing source after an inventory repair', async t => {
  const { createWorkspaceReadContext } = await import('../src/workspace/read-context');
  const hooks = setup(t);
  const browsing = catalog('https://charts.test/repair/browsing');
  const saved = catalog('https://charts.test/repair/saved');
  const current = createWorkspaceReadContext(browsing, [{ catalog: saved, key: 'repair-region', bounds: [[-1, -1, 1, 1]],
    plan: { id: 'repair-region', title: 'Test region', regionId: 'test-region', revision: saved.revision, files: [], references: [] } }]);
  browsing.navigation[0]!.sourceCount = 2;
  saved.navigation[0]!.sourceCount = 2;
  let missing = true, savedCalls = 0, browsingCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    if (String(input) === saved.navigation[0]!.url) {
      savedCalls++;
      if (missing) throw new TypeError('Temporarily unavailable');
    } else browsingCalls++;
    const data = document('SAVED');
    data.features.push({ ...data.features[0]!, id: 'BROWSE', properties: { ident: 'BROWSE', name: 'BROWSE' },
      geometry: { type: 'Point', coordinates: [10, 10] } });
    return Response.json(data);
  });
  const render = () => hooks.render(() => useNavigationData(current, visibility));
  render(); await tick();
  assert.equal(render().loadState.airports, 'partial');
  assert.deepEqual(render().data.airports?.features.map(feature => feature.id), ['BROWSE']);
  assert.equal(render().issues[0]!.regionId, 'test-region');
  missing = false;
  (globals.window as EventTarget).dispatchEvent(new Event('zlayer-offline-inventory'));
  render(); await tick();
  assert.equal(render().loadState.airports, 'ready');
  assert.equal(render().data.airports?.features.length, 2);
  assert.deepEqual(render().issues, []);
  assert.equal(savedCalls, 2);
  assert.equal(browsingCalls, 1);
});
