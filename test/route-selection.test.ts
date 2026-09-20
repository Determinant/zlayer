import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteResolver, routeDraftFromText, sameFeature } from '@zlayer/domain';
import { routePointForFeature, routePointKeys } from '../src/layers/routes/selection';
import { moveRouteEntry, removeRouteEntry } from '../src/layers/routes/draft';

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
