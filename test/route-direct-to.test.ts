import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createRouteResolver, routeCoordinateFeature, routeDraftFromText, routeDraftText } from '@zlayer/domain';
import { directToFeature, directToPosition, directToRoutePoint, directToRouteProblem } from '../src/layers/routes/direct-to';
import { removeRouteEntry } from '../src/layers/routes/draft';
import type { OwnshipSnapshot, OwnshipState } from '../src/layers/ownship/layer';
import { GPS_STALE_MS } from '../src/core/gps/position';
import { createRouteRemovalResolver } from './helpers/route-removal';
import { Hooks, hookModule } from './helpers/hooks';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { useDirectTo } = await import('../src/layers/routes/use-direct-to');
loader.deregister();
const resolve = createRouteRemovalResolver();
const position: [number, number] = [-122, 37];
const origin = '370000N1220000W';

test('direct to each ordinary waypoint trims only its prefix and keeps suffix entries and identities', () => {
  const draft = routeDraftFromText('KSBA TAILS CMA VPTEST 350000N1190000W KSMX UNKNOWN');
  const plan = resolve(draft);
  for (const [index, point] of plan.waypoints.entries()) {
    const next = directToRoutePoint(draft, plan, point, position);
    assert.equal(routeDraftText(next), `${origin} ${draft.entries.slice(index).map(entry => entry.text).join(' ')}`);
    assert.equal(next.entries[1]!.id, point.edit!.entryId);
    assert.equal(next.entries[1]!.pinnedFeatureId, point.feature.id);
    assert.deepEqual(next.entries.slice(2), draft.entries.slice(index + 1));
    assert.deepEqual(resolve(next).waypoints.slice(1).map(point => point.ident), plan.waypoints.slice(index).map(point => point.ident));
    assert.equal(next.entries[0]!.pinnedFeatureId, undefined);
  }
});

for (const [input, target, expected] of [
  ['KSBA ENTRY V1 EXIT KSMX UNKNOWN', 'TAILS', 'TAILS MID EXIT KSMX UNKNOWN'],
  ['KSBA ENTRY V1 V2 AFTER KSMX', 'EXIT', 'EXIT AFTER KSMX'],
  ['KSBA DEP1 EXIT KSMX', 'TAILS', 'TAILS MID EXIT KSMX'],
  ['KSBA TEST1 KSMX CMA', 'TAILS', 'TAILS MID EXIT KSMX CMA'],
  ['KSBA ENTRY V1 EXIT KSMX', 'ENTRY', 'ENTRY V1 EXIT KSMX'],
  ['KSBA ENTRY ARR1 KSMX', 'ENTRY', 'ENTRY ARR1 KSMX'],
  ['KSBA TEST1 KSMX', 'KSBA', 'KSBA TEST1 KSMX'],
] as const) {
  test(`direct to ${target} in ${input} preserves the remaining published path`, () => {
    const draft = routeDraftFromText(input);
    const plan = resolve(draft);
    const point = plan.waypoints.find(point => point.ident === target)!;
    assert.ok(point);
    const next = directToRoutePoint(draft, plan, point, position);
    assert.equal(directToRouteProblem(plan, point), undefined);
    assert.equal(routeDraftText(next), `${origin} ${expected}`);
    assert.deepEqual(resolve(next).waypoints.slice(1).map(point => point.feature.id ?? point.ident),
      plan.waypoints.slice(plan.waypoints.indexOf(point)).map(point => point.feature.id ?? point.ident));
    assert.deepEqual(resolve(next).unresolved, plan.unresolved);
    const legIds = (legs: typeof plan.legs) => legs.map(leg => [leg.from.feature.id, leg.to.feature.id]);
    const remaining = new Set(plan.waypoints.slice(plan.waypoints.indexOf(point)));
    assert.deepEqual(legIds(resolve(next).legs.slice(1)),
      legIds(plan.legs.filter(leg => remaining.has(leg.from) && remaining.has(leg.to))), 'preserve connections after the target');
    for (const entry of next.entries.slice(1).filter(entry => !draft.entries.some(original => original.id === entry.id))) {
      assert.ok(entry.pinnedFeatureId, 'expanded points pin the exact navigation feature');
    }
  });
}

for (const [input, target, options] of [
  ['KSBA ENTRY V1 EXIT KSMX', 'TAILS', { missingFix: 'MID' }],
  ['KSBA TEST1 KSMX', 'TAILS', { missingFix: 'MID' }],
  ['KSBA DEP1 EXIT KSMX', 'TAILS', { missingFix: 'MID' }],
  ['KSBA ENTRY ARR1 KSMX', 'TAILS', { procedureGapAfter: 'TAILS' }],
  ['KSBA DEP1 EXIT KSMX', 'TAILS', { procedureGapAfter: 'TAILS' }],
  // Procedure previews also leave airport connections open without an issue.
  ['KSBA ENTRY ARR1 KSMX', 'TAILS', {}],
  ['KSBA DEP1 EXIT KSMX', 'KSBA', {}],
] as const) {
  test(`direct to ${target} leaves ${input} intact when expansion would erase a gap or warning (${JSON.stringify(options)})`, () => {
    const resolve = createRouteRemovalResolver(options);
    const draft = routeDraftFromText(input), plan = resolve(draft);
    const point = plan.waypoints.find(point => point.ident === target)!;
    assert.match(directToRouteProblem(plan, point)!, /cannot preserve|discontinuity/);
    assert.equal(directToRoutePoint(draft, plan, point, position), draft);
  });
}

test('direct to preserves warnings in untouched published suffixes and can trim past a broken item', () => {
  const resolve = createRouteRemovalResolver({ missingFix: 'MID' });
  const draft = routeDraftFromText('KSBA ENTRY V1 EXIT KSMX'), plan = resolve(draft);
  assert.ok(plan.issues.length);
  const entry = plan.waypoints.find(point => point.ident === 'ENTRY')!;
  const kept = directToRoutePoint(draft, plan, entry, position);
  assert.equal(routeDraftText(kept), `${origin} ENTRY V1 EXIT KSMX`);
  assert.deepEqual(resolve(kept).issues.map(issue => issue.message), plan.issues.map(issue => issue.message));
  const exit = plan.waypoints.find(point => point.ident === 'EXIT')!;
  const trimmed = directToRoutePoint(draft, plan, exit, position);
  assert.equal(routeDraftText(trimmed), `${origin} EXIT KSMX`);
  assert.deepEqual(resolve(trimmed).issues, []);
});

test('a rejected direct to explains the problem without offering to clear the route', t => {
  const hooks = new Hooks();
  Object.assign(globalThis, { testHooks: hooks });
  t.after(() => hooks.unmount());
  const resolve = createRouteRemovalResolver({ missingFix: 'MID' });
  let draft = routeDraftFromText('KSBA ENTRY V1 EXIT KSMX');
  const original = draft, plan = resolve(draft);
  const layer = { subscribe: () => () => {}, getSnapshot: tracking };
  const render = () => hooks.render(() => useDirectTo(layer, plan, edit => { draft = edit(draft); }));
  const point = plan.waypoints.find(point => point.ident === 'TAILS')!;
  render().action!(point.feature, point);
  const confirmation = render().confirmation!;
  assert.match(confirmation.problem!, /MID/);
  assert.equal(confirmation.available, false);
  confirmation.confirm();
  assert.equal(draft, original);
  confirmation.cancel();
  assert.equal(render().confirmation, undefined);
});

test('direct to a repeated point keeps the selected occurrence in direct and expanded routes', () => {
  for (const input of ['KSBA TAILS ENTRY TAILS KSMX', 'KSBA LOOP1 KSMX']) {
    const draft = routeDraftFromText(input);
    const plan = resolve(draft);
    const matches = plan.waypoints.filter(point => point.ident === 'TAILS');
    assert.equal(routeDraftText(directToRoutePoint(draft, plan, matches[0]!, position)), `${origin} TAILS ENTRY TAILS KSMX`);
    assert.equal(routeDraftText(directToRoutePoint(draft, plan, matches[1]!, position)), `${origin} TAILS KSMX`);
  }
});

test('the target stays the same feature when the GPS origin is closer to another matching identifier', () => {
  const resolve = createRouteResolver([{ type: 'FeatureCollection',
    meta: { layer: 'fixes', revision: 'test', returned: 2, truncated: false },
    features: [-120, -122].map(longitude => ({ type: 'Feature', id: `fix:${longitude}`,
      geometry: { type: 'Point', coordinates: [longitude, 37] }, properties: { kind: 'fix', ident: 'DUP' } })),
  }]);
  const draft = routeDraftFromText('370000N1200000W DUP');
  const plan = resolve(draft);
  assert.equal(plan.waypoints[1]!.feature.id, 'fix:-120');
  assert.equal(resolve(directToRoutePoint(draft, plan, plan.waypoints[1]!, position)).waypoints[1]!.feature.id, 'fix:-120');
});

test('stale plans and foreign waypoint occurrences never change the draft', () => {
  const draft = routeDraftFromText('KSBA TEST1 KSMX');
  const plan = resolve(draft);
  const point = plan.waypoints[2]!;
  const changed = removeRouteEntry(draft, draft.entries[0]!.id);
  assert.equal(directToRoutePoint(changed, plan, point, position), changed);
  assert.equal(directToRoutePoint(draft, plan, { ...point }, position), draft);
});

test('off-route direct to creates only a self-contained origin and the pinned target', () => {
  const target = resolve('KSBA').waypoints[0]!.feature;
  const next = directToFeature(target, position);
  assert.equal(routeDraftText(next), `${origin} KSBA`);
  assert.equal(next.entries[1]!.pinnedFeatureId, target.id);
  const coordinate = directToFeature(routeCoordinateFeature([-119, 35]), position);
  assert.equal(resolve(coordinate).waypoints.length, 2);
  assert.equal(coordinate.entries[1]!.pinnedFeatureId, undefined);
});

function tracking(): OwnshipSnapshot {
  return { enabled: true, state: 'tracking', centerRequest: 0, turnRate: null, fix: {
    coordinates: position, accuracy: 5, timestamp: Date.now(), time: performance.now() / 1000, track: null, speed: null,
    altitude: null, altitudeAccuracy: null, estimated: false,
  } };
}

test('direct to requires a current fix, including stationary fixes without speed or track', () => {
  const snapshot = tracking();
  const now = snapshot.fix!.timestamp;
  assert.deepEqual(directToPosition(snapshot, now), position);
  assert.deepEqual(directToPosition(snapshot, now + GPS_STALE_MS - 1), position);
  assert.equal(directToPosition(snapshot, now + GPS_STALE_MS), undefined);
  assert.equal(directToPosition({ ...snapshot, fix: null }, now), undefined);
  for (const state of ['off', 'acquiring', 'stale', 'denied', 'unavailable', 'unsupported', 'insecure', 'paused'] satisfies OwnshipState[]) {
    assert.equal(directToPosition({ ...snapshot, state }, now), undefined);
  }
});

test('actions use the latest fix, confirm off-route clearing, and recheck GPS and draft after confirmation', t => {
  const hooks = new Hooks();
  Object.assign(globalThis, { testHooks: hooks });
  t.after(() => hooks.unmount());
  let snapshot = tracking();
  const layer = { subscribe: () => () => {}, getSnapshot: () => snapshot };
  let draft = routeDraftFromText('KSBA TAILS KSMX');
  let plan = resolve(draft);
  const render = () => hooks.render(() => useDirectTo(layer, plan, edit => { draft = edit(draft); }));
  const action = render().action!;
  snapshot = { ...snapshot, fix: { ...snapshot.fix!, coordinates: [-121, 36] } };
  action(plan.waypoints[1]!.feature, plan.waypoints[1]);
  assert.equal(routeDraftText(draft), '360000N1210000W TAILS KSMX');
  assert.equal(render().confirmation, undefined);
  plan = resolve(draft);
  const before = draft;
  const target = resolve('CMA').waypoints[0]!.feature;
  render().action!(target);
  assert.equal(draft, before, 'opening a confirmation leaves the draft untouched');
  assert.equal(render().confirmation?.ident, 'CMA');
  render().confirmation!.cancel();
  assert.equal(render().confirmation, undefined);
  assert.equal(draft, before, 'cancelling leaves the draft untouched');
  render().action!(target);
  const beforeExpiry = render().confirmation!;
  snapshot = { ...snapshot, fix: { ...snapshot.fix!, timestamp: Date.now() - GPS_STALE_MS } };
  beforeExpiry.confirm();
  assert.equal(draft, before, 'fix expiry while a confirmation is open prevents the edit');
  assert.equal(render().action, undefined);
  assert.equal(render().confirmation?.available, false);
  snapshot = tracking();
  assert.equal(render().confirmation?.available, true);
  const beforeEdit = render().confirmation!;
  draft = removeRouteEntry(draft, draft.entries[0]!.id);
  plan = resolve(draft);
  assert.equal(render().confirmation, undefined, 'a route edit dismisses the old confirmation');
  beforeEdit.confirm();
  assert.equal(routeDraftText(draft), 'TAILS KSMX', 'a changed draft is not overwritten');
  const finalAction = render().action!;
  finalAction(target);
  snapshot = { ...snapshot, fix: { ...snapshot.fix!, coordinates: [-123, 38] } };
  render().confirmation!.confirm();
  assert.equal(routeDraftText(draft), '380000N1230000W CMA', 'confirmation uses the latest position');
  assert.equal(render().confirmation, undefined);
  snapshot = { ...snapshot, state: 'stale' };
  finalAction(target);
  assert.equal(render().confirmation, undefined, 'an old action cannot prompt after GPS is lost');
  assert.equal(routeDraftText(draft), '380000N1230000W CMA');
});
