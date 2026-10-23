import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotamRecord } from '@zlayer/contracts';
import { notice, aixm } from './fixtures/notams';
import { permutations, batchPartitions } from './helpers/permutations';
import { createNotamXmlParser, recordWithRevision } from '../tools/info-server/notams/normalize';
import { compareNotamContent, resolveNotamRevision } from '../tools/info-server/notams/revision';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';

const changed = (record: NotamRecord, patch: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = record; return recordWithRevision({ ...facts, ...patch });
};
const base = changed(notice(), { locations: ['TST', 'ZZX'], icaoLocations: ['KTST', 'KZZX'] });
const equivalent = changed(base, { locations: ['ZZX', 'TST'], icaoLocations: ['KZZX', 'KTST'],
  effectiveStart: '2026-10-04T11:59:00.000000000Z', effectiveEnd: '2026-10-05T12:00:00Z' });

test('location membership and exact UTC instants reconcile without rewriting source fields', () => {
  const parsed: NotamRecord[] = [];
  for (const r of [base, equivalent]) {
    const parser = createNotamXmlParser(r => parsed.push(r), { count: 1, snapshotAt: base.updatedAt });
    parser.write(aixm(r)); parser.finish();
  }
  for (const pair of [[base, equivalent], parsed]) for (const order of permutations(pair)) {
    const originals = structuredClone(order), comparison = compareNotamContent(order[0]!, order[1]!);
    assert.equal(comparison.outcome, 'equivalent'); assert.deepEqual(comparison.fields, []);
    assert.ok(comparison.evidence.includes('location-set-equivalence'));
    assert.ok(comparison.evidence.includes('validity-time-equivalence'));
    const decision = resolveNotamRevision(order); assert.equal(decision.kind, 'resolved');
    if (decision.kind === 'resolved') {
      assert.deepEqual(decision.record.locations, order[0]!.locations);
      assert.equal(decision.record.effectiveStart, order[0]!.effectiveStart);
      assert.equal(decision.record.effectiveEnd, order[0]!.effectiveEnd);
      assert.equal(decision.record.sourceUpdatedAt, order[0]!.sourceUpdatedAt);
    }
    assert.deepEqual(order, originals, 'comparison leaves both original representations intact');
  }
});

test('UTC representation equality retains seconds, nanoseconds and end semantics', () => {
  for (const effectiveStart of ['20261004115900', '2026-10-04T11:59:00Z', ' 2026-10-04T11:59:00.0Z ']) {
    assert.equal(resolveNotamRevision([base, changed(base, { effectiveStart })]).kind, 'resolved');
  }
  const fractional = changed(base, { effectiveStart: '2026-10-04T11:59:00.1234Z', startsAt: base.startsAt! + 123 });
  assert.equal(resolveNotamRevision([fractional, changed(fractional, { effectiveStart: '2026-10-04T11:59:00.123400000Z' })]).kind, 'resolved');
  const estimated = changed(base, { effectiveEnd: '202610051200EST', endKind: 'estimated' });
  assert.equal(resolveNotamRevision([estimated, changed(estimated, { effectiveEnd: '2026-10-05T12:00:00.000Z' })]).kind, 'resolved');
  const negative: Partial<NotamRecord>[] = [
    { effectiveStart: '2026-10-04T11:59:00.000000001Z' }, // same JavaScript millisecond, different instant
    { effectiveStart: '20261004115901', startsAt: base.startsAt! + 1000 },
    { effectiveStart: '2026-10-04T11:59:00+00:00' }, // outside the accepted source grammar
    { effectiveStart: '202610041159EST' }, // EST is end evidence only
    { effectiveStart: 'UNKNOWN', startsAt: null },
    { effectiveStart: '2026-10-04T11:59:00Z', startsAt: null },
    { effectiveStart: '2026-10-04T11:59:01Z' }, // inconsistent raw/derived time
    { effectiveEnd: '2026-10-05T12:00:00.000000001Z' },
    { effectiveEnd: '202610051200EST', endKind: 'estimated' }, // fixed versus estimated
    { effectiveEnd: 'PERM', endsAt: null, endKind: 'permanent' },
  ];
  for (const patch of negative) for (const order of permutations([base, changed(base, patch)])) {
    assert.equal(resolveNotamRevision(order).kind, 'unresolved', JSON.stringify(patch));
  }
  for (const [a, b] of [['202602300000', '2026-03-02T00:00:00Z'], ['UNKNOWN', ''], ['PERM', 'UNKNOWN']] as const) {
    const first = changed(base, { effectiveEnd: a, endsAt: null });
    assert.equal(resolveNotamRevision([first, changed(first, { effectiveEnd: b })]).kind, 'unresolved');
  }
});

test('equivalent structured variations cannot erase a third contradiction or affect an independent identity', () => {
  const independent = changed(base, { id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002' });
  const patches: Partial<NotamRecord>[] = [
    { locations: ['TST'] }, { locations: [] }, { locations: ['TST', 'ZZY'] },
    { icaoLocations: ['KTST', 'KZZY'] }, { effectiveStart: '202610041200', startsAt: base.startsAt! + 60_000 },
    { effectiveEnd: '202610051201', endsAt: base.endsAt! + 60_000 },
    { text: base.text.replace('09L', '09R') }, { text: base.text.replace('U/S', 'OPERATING') },
    { lifecycle: 'unknown' },
  ];
  for (const patch of patches) {
    const contrary = changed(base, patch);
    for (const order of permutations([base, equivalent, contrary])) for (const batches of batchPartitions(order)) {
      let state: ReturnType<typeof collectNotamRecords> = { records: [independent] };
      for (const batch of batches) state = collectNotamRecords(state, batch);
      assert.deepEqual(state.records, [independent], JSON.stringify(patch)); assert.equal(state.issues?.length, 1);
      const repeated = collectNotamRecords(state, [base, equivalent]);
      assert.equal(repeated.issues?.length, 1);
      assert.equal(rebaseNotamRecords(repeated, [base, independent], base.updatedAt).issues?.length, 1);
      const newer = changed(base, { updatedAt: base.updatedAt + 1000, sourceUpdatedAt: '2026-10-04T11:59:01Z' });
      assert.equal(collectNotamRecords(repeated, [newer]).issues?.length ?? 0, 0);
    }
  }
});
