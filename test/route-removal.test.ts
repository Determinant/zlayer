import assert from 'node:assert/strict';
import test from 'node:test';
import { routeDraftFromText, routeDraftText } from '@zlayer/domain';
import { removeRouteEntry } from '../src/layers/routes/draft';
import { removeRoutePoint, routeItemsForPoint } from '../src/layers/routes/removal';
import { routePointForFeature, routePointKeys } from '../src/layers/routes/selection';
import { createRouteRemovalResolver } from './helpers/route-removal';

const resolve = createRouteRemovalResolver();

test('every direct point can be removed, including endpoints, navaids, VFR points and the only airport', () => {
  for (const input of ['KSBA TAILS CMA VPTEST 350000N1190000W KSMX', 'KSBA']) {
    const draft = routeDraftFromText(input);
    const plan = resolve(draft);
    assert.equal(plan.waypoints.length, draft.entries.length);
    for (const point of plan.waypoints) {
      const remaining = removeRoutePoint(draft, plan, point);
      assert.deepEqual(remaining.entries, draft.entries.filter(entry => entry.id !== point.source.entryId));
      assert.deepEqual(resolve(remaining).waypoints.map(point => point.ident), plan.waypoints
        .filter(candidate => candidate !== point).map(point => point.ident));
    }
  }
});

for (const [input, target, items, expected] of [
  ['KSBA ENTRY V1 EXIT KSMX UNKNOWN', 'TAILS', ['V1'], 'KSBA ENTRY MID EXIT KSMX UNKNOWN'],
  ['KSBA ENTRY V1 V2 AFTER KSMX', 'EXIT', ['V1', 'V2'], 'KSBA ENTRY TAILS MID AFTER KSMX'],
  ['KSBA DEP1 EXIT KSMX', 'TAILS', ['DEP1'], 'KSBA ENTRY MID EXIT KSMX'],
  ['KSBA DEP1 EXIT KSMX', 'KSBA', ['DEP1'], 'ENTRY TAILS MID EXIT KSMX'],
  ['KSBA ENTRY ARR1 KSMX', 'KSMX', ['ARR1'], 'KSBA ENTRY TAILS MID EXIT'],
  ['KSBA TEST1 KSMX CMA', 'TAILS', ['TEST1'], 'KSBA ENTRY MID EXIT KSMX CMA'],
  ['KSBA TEST1 KSMX CMA', 'KSBA', ['TEST1'], 'ENTRY TAILS MID EXIT KSMX CMA'],
] as const) {
  test(`remove only ${target} from ${input} while preserving other points and unrelated entries`, () => {
    const draft = routeDraftFromText(input);
    const plan = resolve(draft);
    const point = plan.waypoints.find(point => point.ident === target)!;
    assert.ok(point);
    assert.deepEqual(routeItemsForPoint(plan, point).map(entry => entry.text), items);
    const remaining = removeRoutePoint(draft, plan, point);
    assert.equal(routeDraftText(remaining), expected);
    assert.deepEqual(resolve(remaining).waypoints.map(point => point.feature.id ?? point.ident),
      plan.waypoints.filter(candidate => candidate !== point).map(point => point.feature.id ?? point.ident));
    for (const entry of draft.entries.filter(entry => !items.some(item => item === entry.text) && entry.id !== point.source.entryId)) {
      assert.equal(remaining.entries.find(candidate => candidate.id === entry.id), entry);
    }
    for (const entry of remaining.entries.filter(entry => !draft.entries.includes(entry))) {
      assert.ok(entry.pinnedFeatureId, 'expanded published points retain their exact feature identity');
    }
  });
}

test('removing a whole airway or procedure remains distinct from removing just one child', () => {
  for (const input of ['KSBA ENTRY V1 EXIT KSMX', 'KSBA DEP1 EXIT KSMX', 'KSBA TEST1 KSMX']) {
    const draft = routeDraftFromText(input);
    const plan = resolve(draft);
    const point = plan.waypoints.find(point => point.ident === 'TAILS')!;
    const item = routeItemsForPoint(plan, point)[0]!;
    const remaining = removeRouteEntry(draft, item.id);
    assert.equal(remaining.entries.some(entry => entry.id === item.id), false);
    assert.equal(resolve(remaining).waypoints.some(point => point.ident === 'MID'), false);
    assert.equal(resolve(removeRoutePoint(draft, plan, point)).waypoints.some(point => point.ident === 'MID'), true);
  }
});

test('repeated children in a published item have distinct selections and remove only the chosen occurrence', () => {
  const draft = routeDraftFromText('KSBA LOOP1 KSMX');
  const plan = resolve(draft);
  const matches = plan.waypoints.filter(point => point.ident === 'TAILS');
  assert.equal(matches.length, 2);
  const keys = routePointKeys(plan);
  assert.notEqual(keys.get(matches[0]!), keys.get(matches[1]!));
  assert.equal(routePointForFeature(plan, matches[1]!.feature, keys.get(matches[1]!)), matches[1]);
  const remaining = removeRoutePoint(draft, plan, matches[1]!);
  assert.equal(routeDraftText(remaining), 'KSBA TAILS ENTRY KSMX');
  assert.ok(routePointForFeature(resolve(remaining), matches[1]!.feature, keys.get(matches[1]!)),
    'the same detail panel still offers removal for the remaining occurrence');
});

test('a stale removal callback never rewrites a changed draft', () => {
  const draft = routeDraftFromText('KSBA TEST1 KSMX');
  const plan = resolve(draft);
  const point = plan.waypoints.find(point => point.ident === 'TAILS')!;
  const changed = removeRouteEntry(draft, draft.entries[0]!.id);
  assert.equal(removeRoutePoint(changed, plan, point), changed);
});
