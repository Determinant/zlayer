import assert from 'node:assert/strict';
import test from 'node:test';

import { createRouteResolver, routeCoordinateFeature, routeDraftText, routeEntryPins, type RouteDraft } from '@zlayer/domain';
import { draftSnapshot } from './helpers/route-draft';
import type { GeoPointFeature } from '@zlayer/contracts';

import {
  appendRouteFeature,
  appendRouteText,
  insertRouteFeature,
  insertRouteTextBefore,
  moveRouteEntry,
  removeRouteEntry,
  replaceRouteFeature,
  replaceRouteText,
  routeDraftFromText,
} from '../src/layers/routes/draft';

test('GPS leg insertions survive serialization and route text export without navigation pins', () => {
  const draft = routeDraftFromText('370000N1220000W 380000N1230000W');
  const coordinate = routeCoordinateFeature([-122.5, 37.25]);
  const inserted = insertRouteFeature(draft, draft.entries[0]!.id, coordinate);
  assert.equal(routeDraftText(inserted), '370000N1220000W 371500N1223000W 380000N1230000W');
  assert.deepEqual(routeEntryPins(inserted.entries), {});
  assert.equal(inserted.entries[0], draft.entries[0]);
  assert.equal(inserted.entries[2], draft.entries[1]);
  const resolve = createRouteResolver([]);
  for (const input of [JSON.parse(JSON.stringify(inserted)), routeDraftText(inserted)]) {
    const plan = resolve(input);
    assert.equal(plan.legs.length, 2);
    assert.deepEqual(plan.issues, []);
    assert.deepEqual(plan.waypoints[1]!.feature, coordinate);
  }
});

test('manual text replaces route pins', () => {
  const draft = appendRouteFeature(routeDraftFromText('KHWD'), point('airport:ksfo', 'KSFO'));
  assert.deepEqual(routeEntryPins(routeDraftFromText(routeDraftText(draft)).entries), {});
});

test('entry IDs stay unique when randomUUID is unavailable on an HTTP development origin', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
  t.after(() => descriptor ? Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor)
    : Reflect.deleteProperty(globalThis.crypto, 'randomUUID'));
  const first = routeDraftFromText('SNS SNS'), second = routeDraftFromText('SNS SNS');
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size, 4);
});

test('duplicate labels have stable distinct identities through edits and stale IDs never target a replacement draft', () => {
  const original = appendRouteFeature(routeDraftFromText('SNS SNS'), point('airport:ksfo', 'KSFO'));
  const [first, second, last] = original.entries;
  assert.notEqual(first!.id, second!.id);
  const moved = moveRouteEntry(original, second!.id, first!.id);
  assert.deepEqual(moved.entries, [second, first, last]);
  const inserted = insertRouteTextBefore(moved, first!.id, 'DCT OAK');
  assert.equal(inserted.entries[0], second);
  assert.equal(inserted.entries[2], first);
  assert.equal(inserted.entries[3], last, 'existing entries and pins are carried intact');
  const replaced = replaceRouteFeature(inserted, first!.id, point('fix:new', 'NEW'));
  assert.deepEqual(replaced.entries[2], { id: first!.id, text: 'NEW', pinnedFeatureId: 'fix:new' });
  const removed = removeRouteEntry(replaced, second!.id);
  assert.equal(removed.entries.at(-1), last);
  const fresh = routeDraftFromText('SNS SNS KSFO');
  assert.equal(removeRouteEntry(fresh, first!.id), fresh);
  assert.equal(replaceRouteFeature(fresh, first!.id, point('bad', 'BAD')), fresh);
  assert.equal(moveRouteEntry(fresh, first!.id, fresh.entries[0]!.id), fresh);
  assert.equal(insertRouteTextBefore(fresh, first!.id, 'BAD'), fresh);
  assert.equal(new Set(inserted.entries.map(entry => entry.id)).size, inserted.entries.length);
});

test('reordering tokens carries exact feature pins with their waypoints', () => {
  let draft = appendRouteFeature(routeDraftFromText('KHWD'), point('fix:sns', 'SNS'));
  draft = appendRouteFeature(draft, point('airport:ksfo', 'KSFO'));

  draft = moveRouteEntry(draft, draft.entries[2]!.id, draft.entries[0]!.id);
  assert.equal(routeDraftText(draft), 'KSFO KHWD SNS');
  assert.deepEqual(routeEntryPins(draft.entries), { 0: 'airport:ksfo', 2: 'fix:sns' });

  assert.equal(moveRouteEntry(draft, draft.entries[0]!.id, 'missing'), draft);
});

test('appending typed tokens preserves existing exact feature pins', () => {
  const pinned = appendRouteFeature(
    routeDraftFromText('KHWD'),
    point('navaid:sns', 'SNS'),
  );
  const draft = appendRouteText(pinned, 'ksfo, oak');
  assert.equal(routeDraftText(draft), 'KHWD SNS KSFO OAK');
  assert.deepEqual(routeEntryPins(draft.entries), { 1: 'navaid:sns' });
});

test('direct connectors do not offset feature pins during pasted insertions', () => {
  let draft = appendRouteFeature(routeDraftFromText('KHWD'), point('airport:ksfo', 'KSFO'));
  draft = insertRouteTextBefore(draft, draft.entries[1]!.id, 'sns DCT oak..');
  assert.equal(routeDraftText(draft), 'KHWD SNS OAK KSFO');
  assert.deepEqual(routeEntryPins(draft.entries), { 3: 'airport:ksfo' });
  draft = appendRouteFeature(appendRouteText(draft, 'DIRECT'), point('airport:ksjc', 'KSJC'));
  assert.deepEqual(routeEntryPins(draft.entries), { 3: 'airport:ksfo', 4: 'airport:ksjc' });
});

test('inserting typed tokens before a waypoint shifts exact feature pins', () => {
  let draft = appendRouteFeature(routeDraftFromText(''), point('airport:khwd', 'KHWD'));
  draft = appendRouteFeature(draft, point('airport:ksfo', 'KSFO'));
  draft = insertRouteTextBefore(draft, draft.entries[1]!.id, 'sns v25');

  assert.equal(routeDraftText(draft), 'KHWD SNS V25 KSFO');
  assert.deepEqual(routeEntryPins(draft.entries), {
    0: 'airport:khwd',
    3: 'airport:ksfo',
  });
  assert.equal(insertRouteTextBefore(draft, 'missing', 'OAK'), draft);
  assert.equal(insertRouteTextBefore(draft, draft.entries[1]!.id, '  '), draft);
});

test('feature edits preserve and shift exact feature pins', () => {
  let draft = appendRouteFeature(routeDraftFromText('KHWD'), point('airport:ksfo', 'KSFO'));
  assert.equal(routeDraftText(draft), 'KHWD KSFO');
  assert.deepEqual(routeEntryPins(draft.entries), { 1: 'airport:ksfo' });

  draft = insertRouteFeature(draft, draft.entries[0]!.id, point('fix:sns', 'SNS'));
  assert.equal(routeDraftText(draft), 'KHWD SNS KSFO');
  assert.deepEqual(routeEntryPins(draft.entries), { 1: 'fix:sns', 2: 'airport:ksfo' });

  draft = replaceRouteFeature(draft, draft.entries[1]!.id, point('fix:oak', 'OAK'));
  assert.equal(routeDraftText(draft), 'KHWD OAK KSFO');
  assert.deepEqual(routeEntryPins(draft.entries), { 1: 'fix:oak', 2: 'airport:ksfo' });

  draft = removeRouteEntry(draft, draft.entries[1]!.id);
  assert.equal(routeDraftText(draft), 'KHWD KSFO');
  assert.deepEqual(routeEntryPins(draft.entries), { 1: 'airport:ksfo' });
});

test('replacing a feature with the same pinned entity preserves its airport attachments', () => {
  const airport = point('airport:ksfo', 'KSFO');
  const draft: RouteDraft = { entries: appendRouteFeature(routeDraftFromText(''), airport).entries.map(entry => ({
    ...entry, approach: { airportId: 'SFO', procedureId: 'ils28r', name: 'ILS RWY 28R', cycle: 'test' },
    departure: { airportId: 'SFO', procedureId: 'sfo', ident: 'SFO5', name: 'SAN FRANCISCO FIVE',
      effectiveDate: '2026-09-03', transition: 'SNS' },
  })) };
  const entry = draft.entries[0]!;
  assert.equal(replaceRouteFeature(draft, entry.id, { ...airport }), draft);
  const changed = replaceRouteFeature(draft, entry.id, point('other:ksfo', 'KSFO'));
  assert.equal(changed.entries[0]?.pinnedFeatureId, 'other:ksfo');
  assert.equal(changed.entries[0]?.approach, undefined, 'a different entity must not inherit airport attachments');
  assert.equal(changed.entries[0]?.departure, undefined);
});

test('typed replacement changes only the targeted entry and clears its old feature pin', () => {
  const draft = routeDraftFromText('KSFO SNS SNS KSNS', { 0: 'airport:sfo', 1: 'navaid:sns', 2: 'navaid:sns', 3: 'airport:sns' });
  const target = draft.entries[2]!;
  const replaced = replaceRouteText(draft, target.id, ' oak ');
  assert.equal(routeDraftText(replaced), 'KSFO SNS OAK KSNS');
  assert.deepEqual(replaced.entries[2], { id: target.id, text: 'OAK' });
  assert.deepEqual(routeEntryPins(replaced.entries), { 0: 'airport:sfo', 1: 'navaid:sns', 3: 'airport:sns' });
  for (const index of [0, 1, 3]) assert.equal(replaced.entries[index], draft.entries[index]);
  const moved = moveRouteEntry(draft, target.id, draft.entries[0]!.id);
  assert.equal(replaceRouteText(moved, target.id, 'OAK').entries[0]!.text, 'OAK', 'replacement follows identity after reordering');
  for (const input of ['', '  ', 'DCT DIRECT', 'sns']) assert.equal(replaceRouteText(draft, target.id, input), draft);
  assert.equal(replaceRouteText(draft, 'missing', 'OAK'), draft);
});

test('pasting a replacement segment preserves surrounding pins and assigns distinct entry identities', () => {
  const draft = routeDraftFromText('KSFO BAD KSNS', { 0: 'airport:sfo', 1: 'old-feature', 2: 'airport:sns' });
  const replaced = replaceRouteText(draft, draft.entries[1]!.id, 'sfo DCT sns');
  assert.equal(routeDraftText(replaced), 'KSFO SFO SNS KSNS');
  assert.equal(replaced.entries[1]!.id, draft.entries[1]!.id);
  assert.equal(new Set(replaced.entries.map(entry => entry.id)).size, 4);
  assert.deepEqual(routeEntryPins(replaced.entries), { 0: 'airport:sfo', 3: 'airport:sns' });
  assert.equal(replaced.entries.at(-1), draft.entries.at(-1));
});

test('unknown entry IDs and unrouteable feature labels cannot shift or orphan pins', () => {
  const draft = appendRouteFeature(routeDraftFromText('KSFO'), point('sjc', 'KSJC'));
  for (const index of ['', 'missing', '0', 'NaN']) {
    assert.equal(insertRouteFeature(draft, index, point('sns', 'SNS')), draft);
  }
  for (const properties of [{ name: 'John Wayne Airport' }, { ident: 'SNS KSFO' }, { ident: 'DCT' }, { ident: '' }]) {
    const feature = { ...point('invalid', ''), properties };
    assert.equal(appendRouteFeature(draft, feature), draft);
    assert.equal(insertRouteFeature(draft, draft.entries[0]!.id, feature), draft);
    assert.equal(replaceRouteFeature(draft, draft.entries[1]!.id, feature), draft);
  }
  const feature = { ...point('sns', 'SNS'), properties: { icaoId: '', faaId: ' SNS ' } };
  assert.deepEqual(draftSnapshot(appendRouteFeature(draft, feature)), { input: 'KSFO KSJC SNS', pinnedFeatureIds: { 1: 'sjc', 2: 'sns' } });
});

function point(id: string, ident: string): GeoPointFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { ident },
  };
}
