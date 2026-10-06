import assert from 'node:assert/strict';
import test from 'node:test';
import { isNotamSourceIssue, isNotamAirportSnapshot, NOTAM_MAX_ISSUE_VARIANTS, type NotamRecord } from '@zlayer/contracts';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { NOTAM_DAY_MS } from '../tools/info-server/notams/policy';
import { notice, notamSnapshot, NOTAM_NOW } from './fixtures/notams';

function record(overrides: Partial<NotamRecord> = {}) {
  const { revision: _revision, ...facts } = notice(overrides);
  return recordWithRevision(facts);
}

test('unrecognized bodies, lifecycle disagreements and unknown lifecycle do not block independent source IDs', () => {
  const old = record(), independent = record({ id: '1757600000000002', sourceId: '1757600000000002' });
  for (const changed of [record({ text: 'A new rendering not anticipated by the adapter' }),
    record({ lifecycle: 'cancelled' }), record({ lifecycle: 'unknown', changeType: 'FUTURE_TYPE' })]) {
    const update = record({ ...independent, updatedAt: NOTAM_NOW, text: 'Independent change' });
    const result = collectNotamRecords({ records: [old, independent] }, [changed, update]);
    assert.deepEqual(result.records, [update]); assert.equal(result.issues?.length, 1);
    const issue = result.issues![0]!;
    assert.ok(isNotamSourceIssue(issue)); assert.equal(issue.id, old.id);
    assert.ok(issue.variants.some(r => r.revision === old.revision)); assert.ok(issue.variants.some(r => r.revision === changed.revision));
    assert.equal(collectNotamRecords(result, [old, changed, update]), result, 'repeated conflict samples do not grow storage');
    const newer = record({ ...changed, updatedAt: NOTAM_NOW + 1, sourceUpdatedAt: new Date(NOTAM_NOW + 1).toISOString(), lifecycle: 'active', changeType: 'N' });
    const resolved = collectNotamRecords(result, [newer]);
    assert.equal(resolved.issues?.length, 0); assert.ok(resolved.records.includes(newer));
  }
});

test('conflict identity and resolution do not depend on batch ordering, duplicate samples or older updates', () => {
  const first = record(), second = record({ text: 'Different content' });
  const old = record({ updatedAt: first.updatedAt - 1, text: 'Old content' });
  const expected = collectNotamRecords({ records: [] }, [first, second]);
  for (const updates of [[first, second, old], [old, second, first], [second, first, second, old]]) {
    assert.deepEqual(collectNotamRecords({ records: [] }, updates), expected);
    assert.equal(collectNotamRecords(expected, updates), expected);
  }
  const newer = record({ updatedAt: NOTAM_NOW, text: 'Newer source revision' });
  for (const updates of [[first, second, newer], [newer, second, first], [second, newer, first]]) {
    assert.deepEqual(collectNotamRecords(expected, updates).records, [newer]);
    assert.equal(collectNotamRecords(expected, updates).issues?.length, 0);
  }
});

test('a sparse compatible rendering cannot erase a disagreement between retained versions', () => {
  const first = record({ translations: [{ type: 'LOCAL_FORMAT', text: 'First restriction' }] });
  const second = record({ translations: [{ type: 'LOCAL_FORMAT', text: 'Different restriction' }] });
  const unresolved = collectNotamRecords({ records: [first] }, [second]);
  const sparse = record({ translations: [] });
  const result = collectNotamRecords(unresolved, [sparse]);
  assert.equal(result.issues?.length, 1); assert.equal(result.records.length, 0);
  assert.equal(result.issues![0]!.variants.length, 3);
});

test('issue scope includes every known airport and becomes global when any scope cannot be established', () => {
  const first = record(), second = record({ locations: ['OTHER'], icaoLocations: ['KOTH'] });
  const result = collectNotamRecords({ records: [first] }, [second]);
  assert.deepEqual(result.issues?.[0]?.locations, ['OTHER', 'TST']);
  assert.deepEqual(result.issues?.[0]?.icaoLocations, ['KOTH', 'KTST']);
  assert.equal(result.issues?.[0]?.unscoped, false);
  const unlocated = record({ locations: [], icaoLocations: [], text: 'Unknown applicability' });
  const global = collectNotamRecords(result, [unlocated]);
  assert.equal(global.issues?.[0]?.unscoped, true); assert.ok(isNotamSourceIssue(global.issues?.[0]));
});

test('variant overflow is bounded, preserves warning scopes and stays unresolved until a newer source revision', () => {
  const variants = Array.from({ length: 40 }, (_, i) => record({ text: `Different source variant ${i}`,
    locations: [String(i).padStart(3, '0')], icaoLocations: [] }));
  const result = collectNotamRecords({ records: [] }, variants), issue = result.issues![0]!;
  assert.equal(issue.variants.length, NOTAM_MAX_ISSUE_VARIANTS); assert.equal(issue.variantsTruncated, true);
  assert.equal(issue.unscoped, true); assert.equal(issue.locations.length, 32); assert.ok(isNotamSourceIssue(issue));
  const retained = collectNotamRecords(result, issue.variants);
  assert.equal(retained, result, 'repeating sampled versions cannot erase overflow evidence');
  const newer = record({ updatedAt: NOTAM_NOW, text: 'New source revision' });
  const resolved = collectNotamRecords(retained, [newer]);
  assert.equal(resolved.issues?.length, 0); assert.deepEqual(resolved.records, [newer]);
});

test('excess compatible translations become local uncertainty instead of an entire-batch failure', () => {
  const variants = Array.from({ length: 3 }, (_, i) => record({ translations: Array.from({ length: 4 }, (_, j) =>
    ({ type: `OTHER:${i * 4 + j}`, text: `Original source ${i * 4 + j}` })) }));
  const result = collectNotamRecords({ records: [] }, variants);
  assert.equal(result.issues?.[0]?.reason, 'representation-limit'); assert.equal(result.issues?.[0]?.variants.length, 3);
  assert.ok(isNotamSourceIssue(result.issues?.[0]));
});

test('full reconciliation retains equal-revision conflicts and resolves absence only at a qualified snapshot boundary', () => {
  const first = record(), second = record({ text: 'Conflicting source' });
  const collection = collectNotamRecords({ records: [first] }, [second]);
  const present = rebaseNotamRecords(collection, [first], NOTAM_NOW);
  assert.deepEqual(present.issues, collection.issues); assert.equal(present.records.length, 0);
  assert.deepEqual(rebaseNotamRecords(collection, [], undefined).issues, collection.issues);
  const absent = rebaseNotamRecords(collection, [], NOTAM_NOW);
  assert.equal(absent.records.length, 0); assert.equal(absent.issues?.length, 0);
  const newer = record({ updatedAt: NOTAM_NOW, text: 'Explicit replacement' });
  assert.equal(rebaseNotamRecords(collection, [newer], NOTAM_NOW).issues?.length, 0);
});

test('a full snapshot cannot erase resolved or unresolved observations newer than its own source boundary', () => {
  const first = record({ updatedAt: NOTAM_NOW, sourceUpdatedAt: new Date(NOTAM_NOW).toISOString() });
  const resolved = { records: [first] };
  for (const boundary of [undefined, NOTAM_NOW - 1, NOTAM_NOW]) {
    assert.deepEqual(rebaseNotamRecords(resolved, [], boundary).records, [first]);
  }
  const conflict = collectNotamRecords(resolved, [record({ ...first, text: 'New observation with disagreement' })]);
  assert.deepEqual(rebaseNotamRecords(conflict, [], NOTAM_NOW).issues, conflict.issues);
  assert.equal(rebaseNotamRecords(resolved, [], NOTAM_NOW + 1).records.length, 0);
  assert.equal(rebaseNotamRecords(conflict, [], NOTAM_NOW + 1).issues?.length, 0);
});

test('full replacement preserves cancellation evidence for two days from the later source event', () => {
  const updatedAt = NOTAM_NOW - 3 * NOTAM_DAY_MS;
  const active = record({ updatedAt, sourceUpdatedAt: new Date(updatedAt).toISOString() });
  const cancelled = record({ ...active, lifecycle: 'cancelled', canceledAt: new Date(NOTAM_NOW).toISOString() });
  const older = record({ ...cancelled, canceledAt: new Date(NOTAM_NOW - NOTAM_DAY_MS).toISOString() });
  for (const variants of [[older, cancelled], [cancelled, older]]) {
    const collection = collectNotamRecords({ records: [] }, variants);
    assert.deepEqual(collection.records, [cancelled], 'retain the later cancellation without advancing its source revision');
    assert.equal(collectNotamRecords(collection, [older, active]), collection, 'older and sparse replays cannot shorten retention');
  }
  for (const inactive of [cancelled,
    record({ ...cancelled, updatedAt: NOTAM_NOW, sourceUpdatedAt: new Date(NOTAM_NOW).toISOString(), canceledAt: older.canceledAt }),
    record({ ...active, lifecycle: 'cancellation', changeType: 'C', updatedAt: NOTAM_NOW, sourceUpdatedAt: new Date(NOTAM_NOW).toISOString() })]) {
    const collection = { records: [inactive] };
    for (const boundary of [undefined, NOTAM_NOW + NOTAM_DAY_MS, NOTAM_NOW + 2 * NOTAM_DAY_MS - 1]) {
      assert.deepEqual(rebaseNotamRecords(collection, [], boundary).records, [inactive]);
    }
    assert.equal(rebaseNotamRecords(collection, [], NOTAM_NOW + 2 * NOTAM_DAY_MS).records.length, 0);
  }
  const rebased = rebaseNotamRecords({ records: [cancelled] }, [], NOTAM_NOW + NOTAM_DAY_MS);
  assert.deepEqual(collectNotamRecords(rebased, [active]).records, [cancelled], 'the bulk bridge must not resurrect a cancelled ID');
  assert.equal(rebaseNotamRecords({ records: [active] }, [], NOTAM_NOW).records.length, 0, 'active records still follow qualified bulk absence');
  const legacy = record({ ...active, lifecycle: 'cancelled', canceledAt: '' });
  assert.equal(rebaseNotamRecords({ records: [legacy] }, [], NOTAM_NOW).records.length, 0, 'missing cancellation time falls back to the update time');
});

test('wire guards reject lost issue evidence, overlapping resolved IDs and false airport completeness', () => {
  const first = record(), second = record({ text: 'Conflicting source' });
  const collection = collectNotamRecords({ records: [first] }, [second]);
  const issue = collection.issues![0]!;
  const snapshot = notamSnapshot([], { issues: [issue], contentCoverage: 'incomplete' });
  snapshot.feed = { ...snapshot.feed, recordCount: 1, collectionContinuity: 'complete', continuity: 'incomplete', unresolvedRecords: 1, unscopedRecords: 0, state: 'degraded', error: 'unresolved-records' };
  assert.ok(isNotamAirportSnapshot(snapshot));
  assert.equal(isNotamAirportSnapshot({ ...snapshot, contentCoverage: 'complete' }), false);
  assert.equal(isNotamAirportSnapshot({ ...snapshot, records: [first] }), false);
  assert.equal(isNotamAirportSnapshot({ ...snapshot, issues: undefined }), false);
  assert.equal(isNotamSourceIssue({ ...issue, locations: [], icaoLocations: [] }), false);
  assert.equal(isNotamSourceIssue({ ...issue, variants: [] }), false);
  const healthy = { ...snapshot, issues: [], contentCoverage: 'complete' };
  assert.ok(isNotamAirportSnapshot(healthy), 'an unrelated airport can have complete content despite a global issue');
  assert.equal(isNotamAirportSnapshot({ ...healthy, feed: { ...snapshot.feed, collectionContinuity: 'incomplete' } }), false);
  assert.equal(isNotamAirportSnapshot({ ...healthy, feed: { ...snapshot.feed, unscopedRecords: 1 } }), false);
});
