import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NotamRecord } from '@zlayer/contracts';
import { notice, NOTAM_NOW } from './fixtures/notams';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { compareNotamRevision, mergeNotamRecords, NotamRevisionConflict } from '../tools/info-server/notams/revision';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { NotamStore } from '../tools/info-server/notams/store';
import { createNotamService } from '../tools/info-server/notams/service';

const record = (fields: Partial<NotamRecord> = {}) => {
  const { revision: _revision, ...facts } = notice(fields); return recordWithRevision(facts);
};
const variants = [record(), record({ sequence: 2 }), record({ correction: 1 })];
const digests = (records: readonly NotamRecord[]) => records.map(record => record.revision).sort();
function permutations<T>(values: readonly T[]): T[][] {
  return values.length ? values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j)).map(rest => [value, ...rest])) : [[]];
}

test('NMS revision ordering uses the precise update instant and never AIXM counters or publication time', () => {
  const original = record();
  for (const fields of [{ sequence: 999, correction: 999 }, { sequence: 0 },
    { correction: 99 }, { issuedAt: NOTAM_NOW }, { sourceUpdatedAt: '2026-10-04T11:59:00.000000000Z' }]) {
    const alternate = record(fields);
    assert.equal(compareNotamRevision(alternate, original), 0);
    assert.equal(compareNotamRevision(original, alternate), 0);
  }
  const later = record({ sequence: 0, correction: 0, sourceUpdatedAt: '2026-10-04T11:59:00.000000001Z' });
  const highCounters = record({ sequence: 999, correction: 999 });
  assert.ok(compareNotamRevision(later, highCounters) > 0);
  assert.ok(compareNotamRevision(highCounters, later) < 0);
  for (const order of permutations([later, highCounters])) assert.deepEqual(mergeNotamRecords([], order), [later]);
  const nextMillisecond = record({ sourceUpdatedAt: '2026-10-04T11:59:00.001Z', updatedAt: original.updatedAt + 1 });
  assert.ok(compareNotamRevision(nextMillisecond, later) > 0);
});

test('equal-time counter disagreements retain every variant across batch, sequential delivery and replay', () => {
  for (const order of permutations(variants)) {
    const together = collectNotamRecords({ records: [] }, order);
    assert.equal(together.records.length, 0); assert.equal(together.issues?.length, 1);
    assert.deepEqual(digests(together.issues![0]!.variants), digests(variants));
    let sequential = collectNotamRecords({ records: [] }, []);
    for (const record of order) sequential = collectNotamRecords(sequential, [record]);
    assert.deepEqual(sequential, together);
    assert.equal(collectNotamRecords(together, order), together);
    assert.equal(collectNotamRecords(together, [variants[1]!]), together, 'higher sequence cannot clear an existing issue');
    assert.equal(collectNotamRecords(together, [variants[2]!]), together, 'higher correction cannot clear an existing issue');
  }
  for (const next of variants.slice(1)) {
    assert.throws(() => mergeNotamRecords([variants[0]!], [next]), error =>
      error instanceof NotamRevisionConflict && error.fields.some(field => field === 'sequence' || field === 'correction'));
  }
});

test('counter increases cannot hide changed operational content or stop independent notices advancing', () => {
  const before = record(), changed = record({ sequence: 2, correction: 1, text: 'RWY 09L CLSD' });
  const independent = record({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002',
    updatedAt: NOTAM_NOW, sourceUpdatedAt: '2026-10-04T12:00:00.000Z' });
  for (const order of permutations([before, changed, independent])) {
    const result = collectNotamRecords({ records: [] }, order);
    assert.deepEqual(result.records, [independent]);
    assert.deepEqual(digests(result.issues![0]!.variants), digests([before, changed]));
  }
});

test('full reconciliation cannot clear tied counters; a genuinely later timestamp supersedes all of them', () => {
  const disputed = collectNotamRecords({ records: [] }, variants);
  for (const variant of variants) {
    const rebased = rebaseNotamRecords(disputed, [variant], NOTAM_NOW);
    assert.deepEqual(digests(rebased.issues![0]!.variants), digests(variants));
  }
  const later = record({ sequence: 0, correction: 0, sourceUpdatedAt: '2026-10-04T11:59:00.000000001Z', text: 'RWY 09L OPEN' });
  const resolved = collectNotamRecords(disputed, [later]);
  assert.deepEqual(resolved.records, [later]); assert.equal(resolved.issues?.length ?? 0, 0);
  assert.equal(collectNotamRecords(resolved, variants), resolved);
});

test('counter-only updates cannot erase bounded overflow evidence', () => {
  const disputed = collectNotamRecords({ records: [] }, Array.from({ length: 10 }, (_, correction) => record({ correction })));
  assert.equal(disputed.records.length, 0); assert.equal(disputed.issues?.[0]?.variants.length, 8);
  assert.equal(disputed.issues?.[0]?.variantsTruncated, true);
  const repeated = collectNotamRecords(disputed, [record({ sequence: 999, correction: 999 })]);
  assert.equal(repeated.records.length, 0); assert.equal(repeated.issues?.[0]?.variantsTruncated, true);
  const later = record({ sourceUpdatedAt: '2026-10-04T12:00:00.000Z', updatedAt: NOTAM_NOW });
  const resolved = collectNotamRecords(repeated, [later]);
  assert.deepEqual(resolved.records, [later]); assert.equal(resolved.issues?.length ?? 0, 0);
});

test('counter changes cannot resurrect an original-ID tombstone, but a later NMS revision can', () => {
  const cancelled = record({ lifecycle: 'cancelled', canceledAt: '2026-10-04T11:59:01.000Z' });
  for (const active of [record({ sequence: 2 }), record({ correction: 9 }), record({ sequence: 0 })]) {
    for (const order of permutations([cancelled, active])) {
      const result = collectNotamRecords({ records: [] }, order);
      assert.deepEqual(result.records, [cancelled]); assert.equal(result.issues?.length ?? 0, 0);
      assert.equal(collectNotamRecords(result, [active]), result);
    }
  }
  const later = record({ sourceUpdatedAt: '2026-10-04T12:00:00.000Z', updatedAt: NOTAM_NOW });
  assert.deepEqual(collectNotamRecords({ records: [cancelled] }, [later]).records, [later]);
});

test('authenticated restart preserves tied counter evidence and source clocks without fetching or resetting admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-revision-order-')), state = join(directory, 'production');
  const store = new NotamStore(state, 'production', () => NOTAM_NOW);
  const disputed = collectNotamRecords({ records: [] }, variants);
  try {
    await store.restore(); await store.reserve('bulk');
    await store.publish({ schemaVersion: 2, environment: 'production', ...disputed,
      complete: true, checkedAt: NOTAM_NOW, watermark: NOTAM_NOW, fullSyncAt: NOTAM_NOW, baselineAt: NOTAM_NOW });
    const budget = await readFile(join(state, 'budget.json'), 'utf8'); await store.close();
    for (let restart = 0; restart < 2; restart++) {
      const service = createNotamService({ enabled: true, environment: 'production', directory,
        credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
        now: () => NOTAM_NOW, signal: new AbortController().signal, fetch: async () => assert.fail('Restore must not acquire source data'),
      });
      try {
        await service.restore();
        const airport = service.readAirport({ icaoId: 'KTST' })!;
        assert.equal(airport.records.length, 0);
        assert.deepEqual(digests(airport.issues![0]!.variants), digests(variants));
        assert.equal(service.status.state, 'degraded'); assert.equal(service.status.blockingRecords, 1);
        assert.equal(service.status.collectionContinuity, 'complete');
        for (const clock of ['checkedAt', 'watermark', 'fullSyncAt'] as const) assert.equal(service.status[clock], NOTAM_NOW);
        assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
      } finally { await service.close(); }
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
