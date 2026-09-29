import assert from 'node:assert/strict';
import test from 'node:test';
import { routeDraftFromText } from '@zlayer/domain';
import { changeRouteStash, editSavedDraft, readRouteStash, ROUTE_STASH_KEY, savedRoute } from '../src/layers/routes/stash';

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}
const approach = { kind: 'approach' as const, source: 'chart' as const, airportId: 'KSFO', procedureId: 'ils', name: 'ILS OR LOC RWY 28R', cycle: '2609',
  entry: { routeId: 'KSFO:I28R', transitionId: 'transition:ARCHI', name: 'ARCHI', effectiveDate: '2026-09-03' } };
const draft = { entries: [
  { id: 'gps', text: '374529N1223030W' },
  { id: 'sfo', text: 'KSFO', pinnedFeatureId: 'KSFO', approach },
] };

test('saved routes keep independent snapshots, optional names, full coordinates, pins and approaches', () => {
  const storage = memoryStorage(), source = structuredClone(draft);
  const unnamed = savedRoute('   ', source), named = savedRoute('  Bay arrival  ', source);
  assert.equal(unnamed.name, '');
  assert.equal(named.name, 'Bay arrival');
  assert.notEqual(unnamed.id, named.id);
  source.entries[0]!.text = 'KSJC';
  changeRouteStash(() => [unnamed, named], storage);
  assert.deepEqual(readRouteStash(storage), [unnamed, named]);
  assert.deepEqual(readRouteStash(storage)[0]!.draft, draft);
  assert.throws(() => savedRoute('', { entries: [] }), /Enter a route/);
});

test('stash changes read the latest records and persist list order', () => {
  const storage = memoryStorage(), first = savedRoute('First', draft), second = savedRoute('Second', draft);
  changeRouteStash(routes => [...routes, first], storage);
  const external = savedRoute('Another tab', draft);
  storage.setItem(ROUTE_STASH_KEY, JSON.stringify({ version: 1, routes: [first, external] }));
  changeRouteStash(routes => [...routes, second], storage);
  assert.deepEqual(readRouteStash(storage).map(route => route.name), ['First', 'Another tab', 'Second']);
  changeRouteStash(routes => [routes[2]!, routes[0]!], storage);
  assert.deepEqual(readRouteStash(storage), [second, first]);
});

test('unreadable records cannot be silently overwritten by saving', () => {
  const storage = memoryStorage(), route = savedRoute('', draft);
  for (const raw of ['{', 'null', '{"version":2,"routes":[]}',
    JSON.stringify({ version: 1, routes: [route, route] }),
    JSON.stringify({ version: 1, routes: [{ ...route, draft: { entries: [] } }] }),
    JSON.stringify({ version: 1, routes: [{ ...route, draft: { entries: [{ id: 'a', text: 'KSFO KSJC' }] } }] })]) {
    storage.setItem(ROUTE_STASH_KEY, raw);
    assert.throws(() => changeRouteStash(routes => [...routes, route], storage), /left untouched/);
    assert.equal(storage.getItem(ROUTE_STASH_KEY), raw);
  }
});

test('storage denial and quota failure surface without losing existing saves', () => {
  const storage = memoryStorage(), route = savedRoute('Existing', draft);
  changeRouteStash(() => [route], storage);
  assert.throws(() => readRouteStash({ ...storage, getItem: () => { throw new Error('denied'); } }), /unavailable/);
  assert.throws(() => changeRouteStash(() => [], { ...storage, setItem: () => { throw new Error('full'); } }), /Could not save/);
  assert.deepEqual(readRouteStash(storage), [route]);
});

test('editing filing text retains attachments and precision on unchanged entries', () => {
  const edited = editSavedDraft(draft, 'ksjc DCT 374529N1223030W..KSFO');
  assert.equal(edited.entries[0]!.text, 'KSJC');
  assert.deepEqual(edited.entries.slice(1), draft.entries);
  assert.notEqual(edited.entries[0]!.id, draft.entries[0]!.id);
  assert.deepEqual(editSavedDraft(draft, '374529N1223030W KSJC').entries.map(entry => entry.approach), [undefined, undefined]);
  assert.deepEqual(editSavedDraft(draft, 'KSFO').entries, [draft.entries[1]]);
  assert.deepEqual(draft.entries[1]!.approach, approach, 'editing does not mutate the saved source');
  assert.throws(() => editSavedDraft(draft, 'DCT ..'), /at least one/);
  assert.deepEqual(editSavedDraft(draft, '374529N/1223030W KSFO'), draft,
    'equivalent external coordinate text preserves saved entry IDs and attachments');
});

test('repeated waypoints keep distinct entry identities when inserting and removing text', () => {
  const original = routeDraftFromText('KSFO KSJC KSFO');
  const result = editSavedDraft(original, 'KSFO KNUQ KSJC KSFO');
  assert.equal(new Set(result.entries.map(entry => entry.id)).size, 4);
  assert.deepEqual([result.entries[0], result.entries[2], result.entries[3]], original.entries);
  assert.deepEqual(editSavedDraft(original, 'KSFO KSFO').entries, [original.entries[0], original.entries[2]]);
});


test('large saved routes preserve unchanged entries without a quadratic table', () => {
  const entries = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i), text: `FIX${i}`, pinnedFeatureId: `pin${i}` }));
  const draft = { entries }, text = entries.map(entry => entry.text).join(' ');
  assert.equal(editSavedDraft(draft, text), draft, 'name-only edits reuse the draft');
  const edited = editSavedDraft(draft, text.replace('FIX5000 ', 'OTHER '));
  assert.equal(edited.entries[4999], entries[4999]);
  assert.equal(edited.entries[5001], entries[5001]);
  assert.equal(edited.entries[5000]!.text, 'OTHER');
  assert.throws(() => editSavedDraft(draft, entries.map((_, i) => `NEW${i}`).join(' ')), /smaller sections/);
  assert.equal(draft.entries, entries, 'a rejected edit leaves the saved draft intact');
});


test('suffix optimization preserves occurrence matching for repeated destination tokens', () => {
  const draft = routeDraftFromText('KSFO KSJC KSJC');
  const result = editSavedDraft(draft, 'KSJC KSJC KSJC');
  assert.equal(result.entries[1], draft.entries[1]);
  assert.equal(result.entries[2], draft.entries[2]);
  assert.notEqual(result.entries[0]!.id, draft.entries[1]!.id);
  assert.equal(editSavedDraft(draft, 'KSJC').entries[0], draft.entries[1],
    'removing a repeated visit keeps the first matched occurrence');
});
