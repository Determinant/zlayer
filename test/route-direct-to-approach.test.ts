import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isTerminalProceduresData, type FeatureCollectionResponse } from '@zlayer/contracts';
import { createRouteResolver, routeDraftFromText, routeDraftText, type RouteApproach, type RoutePlan } from '@zlayer/domain';
import { directToRoutePoint, directToRouteProblem } from '../src/layers/routes/direct-to';
import { setRouteApproach } from '../src/layers/routes/draft';
import { restoreApproachSelection, routePointForFeature, routePointKeys } from '../src/layers/routes/selection';

const terminal: unknown = JSON.parse(readFileSync(new URL('./fixtures/route-approach-legs.json', import.meta.url), 'utf8'));
assert.ok(isTerminalProceduresData(terminal));
const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
  meta: { layer: 'airports', revision: 'test', returned: 2, truncated: false },
  features: ['KSFO', 'KSJC'].map((ident, index) => ({ type: 'Feature', id: ident, properties: { ident },
    geometry: { type: 'Point', coordinates: index ? [-121.929, 37.362] : [-122.375, 37.619] } })),
};
const selected: RouteApproach = { airportId: 'KSFO', procedureId: 'ils', name: 'ILS OR LOC RWY 28R', cycle: '2609',
  entry: { routeId: 'KSFO:I28R', transitionId: 'transition:ARCHI', name: 'ARCHI', effectiveDate: '2026-09-03' } };
const resolve = createRouteResolver([airports], undefined, terminal);
const position: [number, number] = [-122, 37];
const origin = '370000N1220000W';
function draft(approach = selected) {
  const route = routeDraftFromText('KSJC KSFO UNKNOWN KSJC');
  return setRouteApproach(route, route.entries[1]!, approach);
}

test('direct to each approach fix expands the landing remainder before the airport and clears only that bundle', () => {
  const original = draft(), plan = resolve(original);
  const children = plan.waypoints.filter(point => point.approachPhase === 'approach');
  for (const [index, point] of children.entries()) {
    assert.equal(directToRouteProblem(plan, point), undefined);
    const next = directToRoutePoint(original, plan, point, position);
    const expected = children.slice(index);
    assert.equal(routeDraftText(next), `${origin} ${expected.map(point => point.ident).join(' ')} KSFO UNKNOWN KSJC`);
    assert.equal(next.entries.find(entry => entry.text === 'KSFO')!.id, original.entries[1]!.id);
    assert.ok(next.entries.every(entry => !entry.approach));
    assert.deepEqual(next.entries.slice(-2), original.entries.slice(2));
    assert.ok(next.entries.slice(1, -2).every(entry => entry.pinnedFeatureId));
    // A fresh resolver and serialized draft exercise persisted pins without any
    // ordinary navigation fixes (including the local runway name).
    const reloaded: RoutePlan = createRouteResolver([airports], undefined, terminal)(JSON.parse(JSON.stringify(next)));
    assert.deepEqual(reloaded.waypoints.slice(1, 1 + expected.length).map(point => point.feature), expected.map(point => point.feature));
    assert.deepEqual(reloaded.unresolved, ['UNKNOWN']);
    assert.deepEqual(reloaded.legs.map(leg => [leg.from.ident, leg.to.ident]),
      [origin, ...expected.map(point => point.ident), 'KSFO'].slice(1).map((to, index, targets) => [index ? targets[index - 1] : origin, to]));
    assert.ok(reloaded.waypoints.every(point => point.edit && !point.approachPhase && !point.approachHold));
    assert.equal(routePointForFeature(reloaded, point.feature)?.edit?.entryId, next.entries[1]!.id);
  }
});

test('direct to a VTF final fix adds the GPS leg and removes the extension and missed branch', () => {
  const original = draft({ ...selected, entry: { ...selected.entry!, transitionId: 'vectors', name: 'VTF' } });
  const plan = resolve(original), point = plan.waypoints.find(point => point.ident === 'AXMUL')!;
  assert.equal(plan.approachExtensions?.length, 1);
  const next = directToRoutePoint(original, plan, point, position), updated = resolve(next);
  assert.equal(routeDraftText(next), `${origin} AXMUL RW28R KSFO UNKNOWN KSJC`);
  assert.equal(updated.approachExtensions, undefined);
  assert.equal(updated.approachDepictions, undefined);
  assert.deepEqual(updated.legs[0]!.from.feature.geometry.coordinates, position);
  assert.deepEqual(updated.legs[0]!.to.feature.geometry.coordinates, point.feature.geometry.coordinates);
});

test('repeated approaches use the selected occurrence and keep a later bundle unchanged', () => {
  let original = routeDraftFromText('KSJC KSFO KSFO KSFO');
  for (const entry of original.entries.slice(1)) original = setRouteApproach(original, entry, selected);
  const plan = resolve(original), matches = plan.waypoints.filter(point => point.ident === 'CEPIN');
  const point = matches[1]!;
  const key = routePointKeys(plan).get(point)!;
  assert.equal(routePointForFeature(plan, matches[0]!.feature, key), point);
  const next = directToRoutePoint(original, plan, point, position);
  assert.equal(routeDraftText(next), `${origin} CEPIN AXMUL RW28R KSFO KSFO`);
  assert.equal(next.entries.at(-2)!.id, original.entries[2]!.id);
  assert.equal(next.entries.at(-2)!.approach, undefined);
  assert.equal(next.entries.at(-1), original.entries[3]);
});

test('approach pins do not resolve to homonyms or silently fall back when coded data is unavailable', () => {
  const original = draft(), plan = resolve(original), point = plan.waypoints.find(point => point.ident === 'AXMUL')!;
  const next = directToRoutePoint(original, plan, point, position);
  const homonym: FeatureCollectionResponse = { ...airports, meta: { ...airports.meta, layer: 'fixes' },
    features: [{ type: 'Feature', id: 'other:AXMUL', properties: { ident: 'AXMUL' }, geometry: { type: 'Point', coordinates: [-100, 30] } }] };
  assert.deepEqual(createRouteResolver([airports, homonym], undefined, terminal)(next).waypoints[1]!.feature, point.feature);
  assert.ok(createRouteResolver([airports, homonym])(next).unresolved.includes('AXMUL'));
  assert.equal(resolve('AXMUL').waypoints.length, 0, 'coded pins do not change unpinned name resolution');
});

test('only gaps or geometry in the retained landing path prevent approach decomposition', () => {
  const original = draft(), plan = resolve(original), point = plan.waypoints.find(point => point.ident === 'CEPIN')!;
  for (const kind of ['gap', 'arc', 'hold'] as const) {
    const broken = resolve(original), target = broken.waypoints.find(point => point.ident === 'CEPIN')!;
    const leg = broken.legs.find(leg => leg.from === target)!;
    if (kind === 'gap') broken.legs = broken.legs.filter(candidate => candidate !== leg);
    if (kind === 'arc') leg.geometry = [leg.from.feature.geometry.coordinates, [-122.2, 37.5], leg.to.feature.geometry.coordinates];
    if (kind === 'hold') target.approachHold = { turn: 'R', missedEnd: false };
    assert.match(directToRouteProblem(broken, target)!, /discontinuity|curved leg|hold/);
    assert.equal(directToRoutePoint(original, broken, target, position), original);
  }
  plan.legs = plan.legs.filter(leg => leg.from.ident !== 'ARCHI' && leg.approachPhase !== 'missed');
  plan.issues.push({ ...point.source, code: 'approach-discontinuity', message: 'Earlier or missed leg unavailable' });
  assert.equal(directToRouteProblem(plan, point), undefined);
  assert.equal(routeDraftText(directToRoutePoint(original, plan, point, position)), `${origin} CEPIN AXMUL RW28R KSFO UNKNOWN KSJC`);
});

test('missed fixes and stale approach selections cannot become a landing route', () => {
  const original = draft(), plan = resolve(original), missed = plan.waypoints.find(point => point.ident === 'VIKYU')!;
  assert.match(directToRouteProblem(plan, missed)!, /before the missed approach/);
  assert.equal(directToRoutePoint(original, plan, missed, position), original);
  const point = plan.waypoints.find(point => point.ident === 'AXMUL')!;
  const changed = setRouteApproach(original, original.entries[1]!, undefined);
  assert.equal(directToRoutePoint(changed, plan, point, position), changed);
  assert.equal(directToRoutePoint(original, plan, { ...point }, position), original);
});

for (const ending of ['missing fix', 'vectors before missed', 'trailing vectors'] as const) {
  test(`direct to preserves the warning and bundle when the final approach ends with ${ending}`, () => {
    const data = structuredClone(terminal);
    const procedure = data.approaches!.procedures.find(procedure => procedure.id === selected.entry!.routeId)!;
    const runway = procedure.final.findIndex(leg => leg.fix?.ident === 'RW28R');
    if (ending === 'missing fix') delete procedure.final[runway]!.fix;
    else procedure.final.splice(runway, ending === 'trailing vectors' ? procedure.final.length : 1, { path: 'VM' });
    assert.ok(isTerminalProceduresData(data));
    const original = draft(), plan = createRouteResolver([airports], undefined, data)(original);
    assert.ok(plan.issues.some(issue => issue.code === 'approach-discontinuity'));
    for (const ident of ['CEPIN', 'AXMUL']) {
      const target = plan.waypoints.find(point => point.ident === ident)!;
      assert.match(directToRouteProblem(plan, target)!, /incomplete final approach/);
      assert.equal(directToRoutePoint(original, plan, target, position), original);
    }
  });
}

test('an earlier unresolved fix and trailing missed vectors do not block a complete landing remainder', () => {
  const data = structuredClone(terminal);
  const procedure = data.approaches!.procedures.find(procedure => procedure.id === selected.entry!.routeId)!;
  delete procedure.transitions.find(transition => transition.id === 'ARCHI')!.legs[1]!.fix;
  procedure.final.push({ path: 'VM', missed: true });
  const original = draft(), resolver = createRouteResolver([airports], undefined, data), plan = resolver(original);
  assert.ok(plan.issues.some(issue => issue.code === 'approach-discontinuity'));
  const target = plan.waypoints.find(point => point.ident === 'AXMUL')!;
  assert.equal(directToRouteProblem(plan, target), undefined);
  const next = directToRoutePoint(original, plan, target, position);
  assert.equal(routeDraftText(next), `${origin} AXMUL RW28R KSFO UNKNOWN KSJC`);
  assert.deepEqual(resolver(next).unresolved, ['UNKNOWN']);
});

test('legacy saved selections rebind to the exact approach occurrence and keep usable pins after decomposition', () => {
  let original = routeDraftFromText('KSJC KSFO KSFO');
  for (const entry of original.entries.slice(1)) original = setRouteApproach(original, entry, selected);
  const plan = resolve(original), target = plan.waypoints.filter(point => point.ident === 'AXMUL')[1]!;
  const legacy = { ...target.feature, id: `approach:${target.source.entryId}:5:AXMUL`,
    // MapLibre rounds geometry when a clicked feature is saved.
    geometry: { type: 'Point' as const, coordinates: [-122.2572, 37.5715] as [number, number] } };
  const restored = restoreApproachSelection(plan, JSON.parse(JSON.stringify(legacy)));
  assert.equal(restored, target.feature);
  assert.equal(routePointForFeature(plan, legacy), target);
  const next = directToRoutePoint(original, plan, routePointForFeature(plan, legacy)!, position);
  assert.equal(routeDraftText(next), `${origin} AXMUL RW28R KSFO`);
  const reloaded = resolve(JSON.parse(JSON.stringify(next)));
  assert.deepEqual(reloaded.unresolved, []);
  assert.equal(routePointForFeature(reloaded, restored)?.edit?.entryId, next.entries[1]!.id);
  for (const id of [`approach:removed:5:AXMUL`, `approach:${target.source.entryId}:4:AXMUL`, 'other:AXMUL']) {
    const stale = { ...legacy, id };
    assert.equal(restoreApproachSelection(plan, stale), stale, 'never rebind by identifier alone');
    assert.equal(routePointForFeature(plan, stale), undefined);
  }
});
