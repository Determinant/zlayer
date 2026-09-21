import assert from 'node:assert/strict';
import test from 'node:test';
import { routeDraftFromText, routeDraftText, type RouteApproach } from '@zlayer/domain';
import { moveRouteEntry, removeRouteEntry, replaceRouteText, setRouteApproach } from '../src/layers/routes/draft';
import { directToRoutePoint } from '../src/layers/routes/direct-to';
import { routeExportText } from '../src/layers/routes/export';
import { createRouteRemovalResolver } from './helpers/route-removal';

const approach: RouteApproach = { airportId: 'KSMX', procedureId: 'rnav', name: 'RNAV (GPS) RWY 30', cycle: '2609' };

test('an approach belongs to one airport occurrence, follows reorder, switches atomically and detaches without removing the airport', () => {
  const draft = routeDraftFromText('KSBA KSMX KSMX', { 0: 'airport:KSBA', 1: 'airport:KSMX', 2: 'airport:KSMX' });
  const target = draft.entries[1]!;
  const attached = setRouteApproach(draft, target, approach);
  assert.equal(attached.entries.length, 3);
  assert.deepEqual(attached.entries[1], { ...target, approach });
  assert.equal(attached.entries[2], draft.entries[2]);
  const moved = moveRouteEntry(attached, target.id, draft.entries[2]!.id);
  assert.equal(moved.entries[2], attached.entries[1]);
  const switched = setRouteApproach(moved, moved.entries[2]!, { ...approach, procedureId: 'ils', name: 'ILS RWY 30' });
  assert.equal(switched.entries[2]!.id, target.id);
  assert.equal(switched.entries[2]!.approach!.procedureId, 'ils');
  assert.equal(setRouteApproach(switched, switched.entries[2]!, { ...switched.entries[2]!.approach! }), switched);
  const detached = setRouteApproach(switched, switched.entries[2]!, undefined);
  assert.deepEqual(detached.entries[2], target);
  assert.equal(routeDraftText(detached), 'KSBA KSMX KSMX');
  assert.equal(replaceRouteText(attached, target.id, 'KSBA').entries[1]!.approach, undefined);
  assert.equal(setRouteApproach(replaceRouteText(draft, target.id, 'KSBA'), target, approach).entries[1]!.approach, undefined);
  const removed = removeRouteEntry(draft, target.id);
  assert.equal(setRouteApproach(removed, target, approach), removed, 'a late action cannot resurrect a removed airport');
});

test('legacy chart attachments require an entry and retain filing text and attachment identity', () => {
  const resolve = createRouteRemovalResolver();
  const original = routeDraftFromText('KSBA CMA KSMX');
  const draft = setRouteApproach(original, original.entries[2]!, approach);
  const plan = resolve(draft);
  assert.ok(plan.distanceNm < resolve(original).distanceNm);
  assert.equal(routeExportText(plan), 'KSBA CMA KSMX');
  assert.equal(plan.legs.length, 1);
  assert.equal(plan.issues.at(-1)?.code, 'approach-unavailable');
  const direct = directToRoutePoint(draft, plan, plan.waypoints[2]!, [-122, 37]);
  assert.deepEqual(direct.entries[1]!.approach, approach);
  const changed = setRouteApproach(draft, draft.entries[2]!, undefined);
  assert.equal(directToRoutePoint(changed, plan, plan.waypoints[2]!, [-122, 37]), changed,
    'a stale direct-to action cannot restore a removed approach');
});
