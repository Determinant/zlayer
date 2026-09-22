import { draftSnapshot } from './helpers/route-draft';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { isValidElement, type ReactNode, type ReactElement, type HTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GeoPointFeature, NavigationData, PreferredRoutesData, CatalogResponse } from '@zlayer/contracts';
import { routeDraftFromText, type RouteHistoryResults } from '@zlayer/domain';
import type { SavedRoute } from '../src/layers/routes/stash';
import type { RouteDraft } from '../src/layers/routes/draft';
import { createRecommendationModel, recommendationGeometryKey } from '../src/layers/routes/suggestions';
import { resource, revision } from './helpers/route-history';
import { Hooks, hookModule } from './helpers/hooks';

const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/use-persistent-state') && context.parentURL?.includes('/routes/recommendation-results')) {
    return { ...next(specifier, context), url: next(specifier, context).url + '?hooks' };
  }
  if (specifier === 'react' && (/routes\/(use-resource|use-suggestions|use-stash|recommendation-results)/.test(context.parentURL ?? '') ||
    /\/(use-online|use-inventory-version)\.ts$/.test(context.parentURL ?? '') ||
    context.parentURL?.endsWith('use-persistent-state.ts?hooks'))) {
    return { url: hookModule, shortCircuit: true };
  }
  if (context.parentURL?.includes('/routes/use-suggestions')) {
    if (specifier.endsWith('/history/client')) return { url: 'data:text/javascript,' + encodeURIComponent(
      'export const retainRouteHistory = () => () => {}; export const queryRouteHistory = (...args) => globalThis.queryHistoryFixture(...args);'), shortCircuit: true };
    if (specifier === './api') return { url: 'data:text/javascript,' + encodeURIComponent(
      'export const fetchPreferredRoutes = (...args) => globalThis.queryPreferredFixture(...args);'), shortCircuit: true };
  }
  return next(specifier, context);
} });
const { useSuggestions } = await import('../src/layers/routes/use-suggestions');
const { RecommendationSection, RecommendationResults } = await import('../src/layers/routes/recommendation-results');
loader.deregister();

const previousWindow = globalThis.window;
test.before(() => {
  globalThis.window = new EventTarget() as Window & typeof globalThis;
});
test.after(() => { globalThis.window = previousWindow; });

const airport = (faaId: string, lng = -119): GeoPointFeature => ({ type: 'Feature', id: `airport:${faaId}`,
  geometry: { type: 'Point', coordinates: [lng, 34] }, properties: { faaId, icaoId: `K${faaId}` } });
const pair = { origin: airport('SBA', -120), destination: airport('SMO', -118) };
const navigation: NavigationData = { airports: { type: 'FeatureCollection', features: [pair.origin, pair.destination, airport('CMA')],
  meta: { layer: 'airports', revision, returned: 3, truncated: false } },
  fixes: { type: 'FeatureCollection', features: Array.from({ length: 8 }, (_, i) => ({
    ...airport(`FIX${i}`, -119), id: `fix:${i}`, properties: { ident: `FIX${i}` },
    geometry: { type: 'Point' as const, coordinates: [-119, 34 + i / 10] as [number, number] },
  })), meta: { layer: 'fixes', revision, returned: 8, truncated: false } } };
const historical: RouteHistoryResults = { totalCount: 100, engines: ['Piston'], routes: [
  { route: 'KSBA KSMO', count: 92 }, ...Array.from({ length: 8 }, (_, i) => ({ route: `KSBA FIX${i} KSMO`, count: 1 })),
] };
const preferred: PreferredRoutesData = { type: 'ZLayerPreferredRoutes', metadata: { effectiveDate: revision, source: 'FAA' }, routes: [
  { id: 'tec-cma', originId: 'SBA', destinationId: 'SMO', routeType: 'TEC', routeNumber: 1, route: 'CMA', aircraft: 'PQ70',
    segments: [{ sequence: 1, value: 'CMA', type: 'NAVAID' }] },
  { id: 'preferred-low', originId: 'SBA', destinationId: 'SMO', routeType: 'L', routeNumber: 1, route: 'FIX7',
    segments: [{ sequence: 1, value: 'FIX7', type: 'FIX' }] },
] };

test('ranked previews use up to five distinct paths in Frequency, Preferred, TEC order without changing the draft', () => {
  const model = createRecommendationModel(historical, preferred, pair, navigation);
  assert.deepEqual(Object.keys(model.groups), ['frequency', 'preferred', 'tec', 'stash']);
  assert.equal(model.groups.tec[0]!.draft, undefined, 'a missing typed NAVAID must never become an airport');
  const initial = model.preview();
  assert.equal(initial.routes.length, 5);
  assert.deepEqual(initial.routes[0]!.plan.tokens, ['KSBA', 'KSMO']);
  assert.equal(initial.selectedKey, initial.routes[0]!.key);
  assert.equal(model.groups.frequency[0]!.detail, '92 uses · 92%');
  const selected = model.preview('preferred-low');
  assert.equal(selected.routes.length, 5, 'selecting a later route replaces the fifth overlay');
  assert.equal(selected.selectedKey, recommendationGeometryKey(model.planFor(model.groups.preferred[0]!)));
  assert.equal(initial.routes[0]!.key, selected.routes[0]!.key);
  assert.deepEqual(pair.origin, navigation.airports!.features[0]);
  const shared = createRecommendationModel({ ...historical, routes: [{ route: 'KSBA FIX7 KSMO', count: 1 }], totalCount: 1 }, preferred, pair, navigation);
  assert.equal(shared.preview().routes.length, 1, 'the same history/preferred geometry shares a single overlay');
  const fallback = createRecommendationModel(undefined, preferred, pair, navigation);
  assert.equal(fallback.preview().routes.length, 1, 'preferred routes remain available without frequency data');
});

test('stash recommendations match ordered airport identities, preserve saved order and never guess pins or aliases', () => {
  const save = (id: string, text: string, pins = {}): SavedRoute => ({ id, name: id, draft: routeDraftFromText(text, pins) });
  const stash = [save('alias', 'SBA FIX0 SMO'), save('reverse', 'KSMO KSBA'), save('other', 'KSBA KCMA'),
    save('pinned', 'SBA UNKNOWN SMO', { 0: 'airport:SBA', 2: 'airport:SMO' }),
    save('stale-pin', 'KSBA KSMO', { 0: 'airport:gone' }), save('navaid-pin', 'SBA KSMO', { 0: 'navaid:SBA' }),
    save('intermediate-only', 'FIX0 KSBA KSMO FIX1'), save('single', 'KSBA'), save('same-path', 'KSBA FIX0 KSMO')];
  const before = structuredClone(stash);
  const model = createRecommendationModel(undefined, undefined, pair, navigation, undefined, undefined, stash);
  assert.deepEqual(model.groups.stash.map(row => row.id), ['stash:alias', 'stash:pinned', 'stash:same-path']);
  assert.equal(model.preview().routes.length, 1, 'matching geometry shares one overlay; unresolved routes remain listed');
  assert.equal(model.groups.stash[1]!.draft, stash[3]!.draft, 'unknown intermediate entries remain available to Use');
  assert.deepEqual(stash, before, 'lookup and previews do not rewrite saved intent');
  const ambiguous = { ...navigation, airports: { ...navigation.airports!, features: [
    ...navigation.airports!.features, { ...pair.origin, id: 'airport:other-SBA' },
  ] } };
  const matches = createRecommendationModel(undefined, undefined, pair, ambiguous, undefined, undefined, stash);
  assert.deepEqual(matches.groups.stash.map(row => row.id), ['stash:pinned'], 'ambiguous unpinned endpoints are excluded');
});

test('using a saved recommendation retains exact coordinates, waypoint pins and procedure attachments', () => {
  const draft: RouteDraft = { entries: [
    { id: 'origin', text: 'SBA', pinnedFeatureId: 'airport:SBA', departure: {
      kind: 'departure', source: 'cifp', airportId: 'airport:SBA', procedureId: 'SID1', ident: 'SID1',
      name: 'Saved departure', effectiveDate: revision, transition: 'FIX0', branchId: 'branch:1', codedBranches: ['branch:1'],
    } },
    { id: 'coordinate', text: '343000N1193000W' },
    { id: 'destination', text: 'SMO', pinnedFeatureId: 'airport:SMO', approach: {
      kind: 'approach', source: 'chart', airportId: 'airport:SMO', procedureId: 'ILS', name: 'Saved approach', cycle: '2609',
      entry: { routeId: 'SMO:ILS', transitionId: 'FIX0', name: 'FIX0', effectiveDate: revision },
    } },
  ] };
  const model = createRecommendationModel(undefined, undefined, pair, navigation, undefined, undefined,
    [{ id: 'saved', name: 'Coastal arrival', draft }]);
  const before = structuredClone(draft);
  const hooks = new Hooks(); Object.assign(globalThis, { testHooks: hooks });
  const used: RouteDraft[] = [];
  const view = hooks.render(() => RecommendationSection({ id: 'stash', title: 'Route Stash', rows: model.groups.stash,
    model, preview: model.preview(), source: 'Saved on this device', error: undefined, loading: false, empty: '',
    onRetry() {}, onPreview() {}, onUseRoute: value => used.push(value) }));
  assert.match(renderToStaticMarkup(view), /Coastal arrival/);
  click(elements(view, 'button').find(button => button.props['aria-label']?.startsWith('Use route Coastal arrival:'))!);
  assert.deepEqual(used, [before]);
  assert.deepEqual(draft, before);
  hooks.unmount();
});

test('unknown procedures are not bridged by invented map legs, and typed imports recover with navigation', () => {
  const model = createRecommendationModel({ routes: [{ route: 'KSBA SBAP12 KSMO', count: 1 }], totalCount: 1, engines: [] }, preferred, pair, navigation);
  assert.equal(model.planFor(model.groups.frequency[0]!)?.legs.length, 0);
  assert.equal(model.preview().routes.length, 1, 'only the mapped preferred route is previewed');
  assert.equal(draftSnapshot(model.groups.frequency[0]!.draft)?.input, 'KSBA SBAP12 KSMO');
  const recovered = createRecommendationModel(undefined, preferred, pair, { ...navigation,
    navaids: { type: 'FeatureCollection', features: [{ ...airport('CMA'), id: 'navaid:CMA', properties: { ident: 'CMA' } }],
      meta: { layer: 'navaids', revision, returned: 1, truncated: false } },
  });
  assert.deepEqual(draftSnapshot(recovered.groups.tec[0]!.draft)?.pinnedFeatureIds, { 0: 'airport:SBA', 1: 'navaid:CMA', 2: 'airport:SMO' });
  assert.equal(recovered.preview().routes.length, 2);
});

test('selecting a shared path uses the selected route plan, including its tokens and procedure metadata', () => {
  const published: PreferredRoutesData = { ...preferred, routes: [
    { ...preferred.routes[1]!, routeType: 'TEC', designator: 'SBAX1' },
  ] };
  const model = createRecommendationModel({ ...historical, routes: [{ route: 'KSBA FIX7 KSMO', count: 1 }], totalCount: 1 },
    published, pair, navigation);
  const initial = model.preview();
  const row = model.groups.tec[0]!;
  const selected = model.preview(row.id);
  assert.equal(selected.routes.length, 1, 'equal paths still share one overlay');
  assert.equal(selected.selectedKey, initial.selectedKey);
  assert.equal(selected.routes[0]!.plan, model.planFor(row), 'the selected plan must replace the first matching plan');
  assert.deepEqual(selected.routes[0]!.plan.tokens, ['KSBA', 'SBAX1', 'KSMO']);
  assert.deepEqual(initial.routes[0]!.plan.tokens, ['KSBA', 'FIX7', 'KSMO'], 'an earlier preview is not mutated');
});

test('recommendations with equal resolved legs retain distinct planning paths', () => {
  const model = createRecommendationModel({ totalCount: 2, engines: [], routes: [
    { route: 'KSBA FIX0 UNKNOWN FIX1 UNKNOWN KSMO', count: 1 },
    { route: 'KSBA FIX0 UNKNOWN FIX2 UNKNOWN KSMO', count: 1 },
  ] }, undefined, pair, navigation);
  const [first, second] = model.groups.frequency;
  const firstPlan = model.planFor(first!)!, secondPlan = model.planFor(second!)!;
  assert.deepEqual(firstPlan.legs.map(leg => [leg.from.ident, leg.to.ident]), [['KSBA', 'FIX0']]);
  assert.deepEqual(secondPlan.legs.map(leg => [leg.from.ident, leg.to.ident]), [['KSBA', 'FIX0']]);
  assert.deepEqual(firstPlan.planningConnections?.map(({ from, to }) => [from.ident, to.ident]),
    [['FIX0', 'FIX1'], ['FIX1', 'KSMO']]);
  assert.deepEqual(secondPlan.planningConnections?.map(({ from, to }) => [from.ident, to.ident]),
    [['FIX0', 'FIX2'], ['FIX2', 'KSMO']]);
  const preview = model.preview(second!.id);
  assert.equal(preview.routes.length, 2);
  assert.equal(preview.routes.find(route => route.key === preview.selectedKey)?.plan, secondPlan);
  assert.ok(preview.routes.some(route => route.plan === firstPlan), 'selecting the second path retains the first alternative');
});

test('an exact filed TEC code previews the current FAA definition without relabeling the historical route text', () => {
  const codes: PreferredRoutesData = { ...preferred, routes: [{ ...preferred.routes[1]!, routeType: 'TEC', designator: 'SBAX1', altitude: '6000' }] };
  const history: RouteHistoryResults = { routes: [{ route: 'KSBA SBAX1 KSMO', count: 4 }], totalCount: 4, engines: [] };
  const model = createRecommendationModel(history, codes, pair, navigation);
  assert.equal(model.groups.frequency[0]!.route, 'KSBA SBAX1 KSMO');
  assert.equal(draftSnapshot(model.groups.frequency[0]!.draft)?.input, 'KSBA SBAX1 KSMO');
  assert.equal(draftSnapshot(model.groups.tec[0]!.draft)?.input, 'KSBA SBAX1 KSMO');
  assert.deepEqual(model.planFor(model.groups.frequency[0]!)!.tokens, ['KSBA', 'SBAX1', 'KSMO']);
  assert.deepEqual(model.planFor(model.groups.frequency[0]!)!.waypoints.map(point => point.ident), ['KSBA', 'FIX7', 'KSMO']);
  assert.match(model.groups.frequency[0]!.detail, /4 uses · 100%/);
  assert.equal(model.preview().routes.length, 1, 'history and the published TEC share one path');
  const ambiguous = createRecommendationModel(history, { ...codes, routes: [...codes.routes, { ...codes.routes[0]!, id: 'duplicate' }] }, pair, navigation);
  assert.equal(draftSnapshot(ambiguous.groups.frequency[0]!.draft)?.input, 'KSBA SBAX1 KSMO', 'ambiguous definitions are not guessed');
  assert.equal(ambiguous.planFor(ambiguous.groups.frequency[0]!)!.legs.length, 0);
  assert.equal(ambiguous.planFor(ambiguous.groups.frequency[0]!)!.issues[0]?.code, 'tec-ambiguous');
  const markup = (model: ReturnType<typeof createRecommendationModel>) => {
    const hooks = new Hooks(); Object.assign(globalThis, { testHooks: hooks });
    const view = hooks.render(() => RecommendationSection({ id: 'frequency', title: 'Frequency', rows: model.groups.frequency,
      model, preview: model.preview(), source: 'Filed history', error: undefined, loading: false, empty: '',
      onRetry() {}, onPreview() {}, onUseRoute() {} }));
    hooks.unmount();
    return renderToStaticMarkup(view);
  };
  assert.match(markup(model), /current TEC/);
  assert.match(markup(model), /6000/);
  assert.doesNotMatch(markup(ambiguous), /current TEC|6000/, 'no published definition is presented as resolved when it is ambiguous');
});

test('a filed route with multiple TEC segments shows every segment restriction', () => {
  const codes: PreferredRoutesData = { ...preferred, routes: [
    { ...preferred.routes[1]!, id: 'first', routeType: 'TEC', destinationId: 'CMA', designator: 'SBAX1', altitude: '6000' },
    { ...preferred.routes[1]!, id: 'second', routeType: 'TEC', originId: 'CMA', designator: 'CMAX2', altitude: '4000' },
  ] };
  const model = createRecommendationModel({ totalCount: 1, engines: [],
    routes: [{ route: 'KSBA SBAX1 KCMA CMAX2 KSMO', count: 1 }] }, codes, pair, navigation);
  assert.equal(model.planFor(model.groups.frequency[0]!)!.tecRoutes.length, 2);
  const hooks = new Hooks(); Object.assign(globalThis, { testHooks: hooks });
  const view = hooks.render(() => RecommendationSection({ id: 'frequency', title: 'Frequency', rows: model.groups.frequency,
    model, preview: model.preview(), source: 'Filed history', error: undefined, loading: false, empty: '',
    onRetry() {}, onPreview() {}, onUseRoute() {} }));
  hooks.unmount();
  const html = renderToStaticMarkup(view);
  assert.match(html, /<dt>SBAX1 · Altitude<\/dt><dd>6000<\/dd>/);
  assert.match(html, /<dt>CMAX2 · Altitude<\/dt><dd>4000<\/dd>/);
});

test('compact rows share preview/use actions, preserve full-denominator percentages, and page by five', () => {
  const hooks = new Hooks(); Object.assign(globalThis, { testHooks: hooks });
  const model = createRecommendationModel(historical, preferred, pair, navigation);
  const used: RouteDraft[] = []; const selected: string[] = [];
  const render = () => hooks.render(() => RecommendationSection({ id: 'frequency', title: 'Frequency', rows: model.groups.frequency,
    model, preview: model.preview(), source: 'Filed history', error: undefined, loading: false, empty: '',
    onRetry() {}, onPreview: id => selected.push(id), onUseRoute: draft => used.push(draft) }));
  let view = render();
  assert.equal(elements(view, 'li').length, 5);
  assert.match(renderToStaticMarkup(view), /92 uses · 92%/);
  const preview = elements(view, 'button').find(button => button.props['aria-label'] === 'Preview route KSBA KSMO')!;
  assert.equal(preview.props['aria-pressed'], true);
  click(preview);
  assert.deepEqual(used, [], 'previewing never loads the route');
  assert.deepEqual(selected, ['frequency:KSBA KSMO']);
  click(elements(view, 'button').find(button => button.props['aria-label'] === 'Use route KSBA KSMO')!);
  assert.deepEqual(used.map(draftSnapshot), [{ input: 'KSBA KSMO', pinnedFeatureIds: { 0: 'airport:SBA', 1: 'airport:SMO' } }]);
  click(elements(view, 'button').find(button => button.props.className?.split(/\s+/).includes('route-recommend-more'))!);
  view = render();
  assert.equal(elements(view, 'li').length, 9);
  hooks.unmount();
});

test('a failed refresh keeps loaded recommendation rows usable beside its retry action', t => {
  const hooks = new Hooks(); Object.assign(globalThis, { testHooks: hooks });
  t.after(() => hooks.unmount());
  const model = createRecommendationModel(historical, preferred, pair, navigation);
  const used: RouteDraft[] = [];
  let retries = 0;
  const view = hooks.render(() => RecommendationSection({ id: 'frequency', title: 'Frequency', rows: model.groups.frequency,
    model, preview: model.preview(), source: 'Filed history', error: 'Offline', loading: false, empty: '',
    onRetry: () => { retries++; }, onPreview() {}, onUseRoute: draft => used.push(draft) }));
  assert.equal(elements(view, 'li').length, 5);
  assert.match(renderToStaticMarkup(view), /Offline/);
  click(elements(view, 'button').find(button => button.props.children === 'Use')!);
  assert.deepEqual(used, [model.groups.frequency[0]!.draft]);
  const alert = elements(view, 'div').find(element => element.props.role === 'alert');
  assert.ok(alert);
  click(elements(alert.props.children, 'button')[0]!);
  assert.equal(retries, 1);
  assert.ok(elements(view, 'button').some(button => button.props.className?.split(/\s+/).includes('route-recommend-more')));
});

test('source loads ignore replaced queries, recover independently, and cannot overwrite current filters', async t => {
  const hooks = new Hooks();
  const pending: Array<{ resolve: (value: RouteHistoryResults) => void; reject: (reason: Error) => void }> = [];
  Object.assign(globalThis, { testHooks: hooks,
    queryHistoryFixture: () => new Promise<RouteHistoryResults>((resolve, reject) => pending.push({ resolve, reject })),
    queryPreferredFixture: async () => preferred,
  });
  t.after(() => hooks.unmount());
  const catalog: CatalogResponse = { schemaVersion: 1, revision, generatedAt: '2026-09-16T00:00:00Z', charts: [], navigation: [], weather: [],
    routeHistory: resource, preferredRoutes: { id: 'preferred-routes', title: 'Routes', url: '/routes.json', count: 2, sourceCount: 2 } };
  let engine = '';
  const render = () => hooks.render(() => useSuggestions(catalog, pair, engine));
  render(); await setImmediate();
  assert.equal(render().preferred.data, preferred);
  engine = 'Piston'; render();
  pending[0]!.resolve(historical); await setImmediate();
  assert.equal(render().history.data, undefined);
  pending[1]!.reject(new Error('Offline')); await setImmediate();
  assert.equal(render().history.error, 'Offline');
  assert.equal(render().preferred.data, preferred);
  render().history.retry(); render();
  pending[2]!.resolve({ ...historical, totalCount: 50 }); await setImmediate();
  assert.equal(render().history.data?.totalCount, 50);
});

test('changing airport pairs and closing recommendations clear the map preview', async t => {
  const hooks = new Hooks();
  t.after(() => hooks.unmount());
  Object.assign(globalThis, { testHooks: hooks, queryHistoryFixture: async () => historical,
    queryPreferredFixture: async () => preferred });
  const catalog: CatalogResponse = { schemaVersion: 1, revision, generatedAt: '2026-09-16T00:00:00Z', charts: [], navigation: [], weather: [],
    routeHistory: resource, preferredRoutes: { id: 'preferred-routes', title: 'Routes', url: '/routes.json', count: 2, sourceCount: 2 } };
  let currentPair = pair;
  const previews: Array<Parameters<typeof RecommendationResults>[0]['inset'] | undefined> = [];
  const onPreviewChange: Parameters<typeof RecommendationResults>[0]['onPreviewChange'] = preview => previews.push(preview?.inset);
  const inset = { right: 480, bottom: 0 };
  const render = () => hooks.render(() => RecommendationResults({ catalog, pair: currentPair, navigation,
    airways: undefined, inset, onPreviewChange, onPreviewInteraction() {}, onUseRoute() {} }));
  render(); await setImmediate(); render();
  assert.equal(previews.at(-1), inset);
  currentPair = { ...pair, destination: airport('CMA') };
  render();
  assert.equal(previews.at(-1), undefined, 'old airport-pair routes disappear immediately');
  hooks.unmount();
  await setImmediate();
  assert.equal(previews.at(-1), undefined, 'closing prevents pending requests from restoring a preview');
});

test('choosing a route after restoring recommendations releases the saved map camera', async t => {
  const hooks = new Hooks();
  t.after(() => hooks.unmount());
  Object.assign(globalThis, { testHooks: hooks, queryHistoryFixture: async () => historical,
    queryPreferredFixture: async () => preferred });
  const catalog: CatalogResponse = { schemaVersion: 1, revision, generatedAt: '2026-09-16T00:00:00Z', charts: [], navigation: [], weather: [],
    routeHistory: resource, preferredRoutes: { id: 'preferred-routes', title: 'Routes', url: '/routes.json', count: 2, sourceCount: 2 } };
  const previews: Array<{ preserveView?: boolean } | undefined> = [];
  const onPreviewChange: Parameters<typeof RecommendationResults>[0]['onPreviewChange'] = preview => previews.push(preview);
  let preserveView = true;
  const onPreviewInteraction = () => { preserveView = false; };
  const render = () => hooks.render(() => RecommendationResults({ catalog, pair, navigation, airways: undefined,
    inset: { right: 480, bottom: 0 }, preserveView, onPreviewChange, onPreviewInteraction, onUseRoute() {} }));
  render(); await setImmediate();
  const view = render();
  assert.equal(previews.at(-1)?.preserveView, true);
  const frequency = findElement<Parameters<typeof RecommendationSection>[0]>(view, RecommendationSection);
  assert.ok(frequency);
  frequency.props.onPreview('frequency:KSBA KSMO');
  render();
  assert.equal(previews.at(-1)?.preserveView, false, 'an explicit preview may fit even when its geometry was already on the map');
});

function elements(node: ReactNode, type: string): ReactElement<HTMLAttributes<HTMLElement>>[] {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, type));
  if (!isValidElement<HTMLAttributes<HTMLElement>>(node)) return [];
  return node.type === type ? [node] : elements(node.props.children, type);
}
function findElement<P>(node: ReactNode, type: ReactElement['type']): ReactElement<P> | undefined {
  if (Array.isArray(node)) return node.map(child => findElement<P>(child, type)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  return node.type === type ? node as unknown as ReactElement<P> : findElement<P>(node.props.children, type);
}
function click(button: ReactElement<HTMLAttributes<HTMLElement>>) {
  button.props.onClick?.({} as Parameters<NonNullable<typeof button.props.onClick>>[0]);
}
