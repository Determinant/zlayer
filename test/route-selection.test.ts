import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteResolver, routeDraftFromText, sameFeature } from '@zlayer/domain';
import { routePointForFeature, routePointKeys } from '../src/layers/routes/selection';
import { moveRouteEntry, removeRouteEntry } from '../src/layers/routes/draft';
import { createRouteRemovalResolver } from './helpers/route-removal';

test('selection follows an occurrence through reorder and then reflects remaining route membership', () => {
  const resolve = createRouteResolver([]);
  const draft = routeDraftFromText('350000N1190000W 360000N1200000W 350000N1190000W');
  const feature = resolve(draft).waypoints[0]!.feature;
  const target = draft.entries[2]!;
  assert.equal(routePointForFeature(resolve(draft), feature, target.id)?.edit?.entryId, target.id);
  const moved = moveRouteEntry(draft, target.id, draft.entries[0]!.id);
  assert.equal(routePointForFeature(resolve(moved), feature, target.id)?.edit?.entryId, target.id);
  const removed = removeRouteEntry(moved, target.id);
  assert.equal(routePointForFeature(resolve(removed), feature, target.id)?.edit?.entryId, draft.entries[0]!.id);
  assert.equal(routePointForFeature(resolve(removed), feature)?.edit?.entryId, draft.entries[0]!.id);
  assert.equal(routePointForFeature(resolve(removeRouteEntry(removed, draft.entries[0]!.id)), feature, target.id), undefined);
});

test('coordinate identity survives rendered geometry rounding without matching another feature at that position', () => {
  const point = createRouteResolver([])('350000N1190000W').waypoints[0]!.feature;
  assert.equal(sameFeature(point, { ...point, geometry: { type: 'Point', coordinates: [-119.0001, 35.0001] } }), true);
  assert.equal(sameFeature(point, { ...point, id: 'published-fix' }), false);
  assert.equal(sameFeature(point, { ...point, properties: { kind: 'fix', ident: 'FIX' } }), false);
});

test('published expansion points are selectable without direct editing targets', () => {
  const plan = createRouteResolver([])('350000N1190000W');
  const waypoint = plan.waypoints[0]!;
  delete waypoint.edit;
  assert.equal(routePointForFeature(plan, waypoint.feature), waypoint);
  assert.equal(routePointForFeature(plan, waypoint.feature, routePointKeys(plan).get(waypoint)), waypoint);
});

test('repeated-child selection uses point identity and restores former expansion-index selections', () => {
  const draft = routeDraftFromText('KSBA LOOP1 KSMX'), resolve = createRouteRemovalResolver(), plan = resolve(draft);
  const repeated = plan.waypoints.filter(point => point.ident === 'TAILS'), target = repeated[1]!;
  const key = routePointKeys(plan).get(target)!;
  assert.equal(routePointForFeature(plan, target.feature, key), target);
  const old = `expanded:${JSON.stringify([target.source.entryId, 2])}`;
  assert.equal(routePointForFeature(plan, target.feature, old), target);
  const updated = resolve(draft);
  // An unrelated inserted child must not change either repeated point's identity.
  updated.waypoints.splice(2, 0, { ...updated.waypoints.find(point => point.ident === 'ENTRY')!,
    ident: 'OTHER', feature: { ...target.feature, id: 'fix:OTHER', properties: { ident: 'OTHER' } } });
  assert.equal(routePointForFeature(updated, target.feature, key), updated.waypoints.filter(point => point.ident === 'TAILS')[1]);
});
