import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { isNotamRecord, isNotamSourceIssue, type NotamRecord } from '@zlayer/contracts';
import { notice, NOTAM_NOW } from './fixtures/notams';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';

const record = (fields: Partial<NotamRecord> = {}) => {
  const { revision: _revision, ...facts } = notice(fields); return recordWithRevision(facts);
};

test('captured DVV counter differences preserve equivalent content and every supplied counter', async () => {
  const { issue } = JSON.parse(await readFile(new URL('./fixtures/notams-counter-evidence-2026-10-13.json', import.meta.url), 'utf8'));
  assert.ok(isNotamSourceIssue(issue));
  for (const variants of [issue.variants, [...issue.variants].reverse()]) {
    const result = collectNotamRecords({ records: [] }, variants);
    assert.equal(result.issues?.length ?? 0, 0);
    assert.equal(result.records.length, 1);
    const merged = result.records[0]!;
    assert.ok(isNotamRecord(merged));
    assert.equal(merged.text, 'NAV VORTAC NOT MNT');
    assert.deepEqual(merged.locations, ['DVV']); assert.deepEqual(merged.icaoLocations, ['KDEN']);
    assert.deepEqual(merged.sourceCounters, [{ sequence: 1, correction: 0 }, { sequence: 1, correction: 1 }]);
    assert.equal(merged.sourceUpdatedAt, issue.variants[0]!.sourceUpdatedAt);
    for (const variant of variants) for (const translation of variant.translations) {
      assert.ok(merged.translations.some(t => t.type === translation.type && t.text === translation.text));
    }
    assert.equal(collectNotamRecords(result, variants), result, 'repeated evidence is idempotent');
    assert.deepEqual(collectNotamRecords({ records: [], issues: [issue] }, variants), result, 'retained conflicts recover from their existing evidence');
    assert.deepEqual(rebaseNotamRecords(result, [variants[0]!], NOTAM_NOW), result, 'a sparse full snapshot cannot erase counter evidence');
  }
});

test('counter provenance cannot resolve differences in identity, applicability, lifecycle or operational content', () => {
  const before = record();
  const changes: Partial<NotamRecord>[] = [
    { classification: 'FDC' }, { number: '1002' }, { series: 'A' }, { year: '2025' },
    { locations: ['OTHER'] }, { icaoLocations: ['KOTH'] }, { accountability: 'OTHER' },
    { startsAt: NOTAM_NOW, effectiveStart: '202610041200' },
    { endsAt: NOTAM_NOW + 60_000, effectiveEnd: '202610041201' },
    { schedule: 'DLY 1200-1300' }, { changeType: 'R' }, { lifecycle: 'unknown' },
    { text: 'RWY 09L CLSD' }, { referred: { series: 'A', number: '1', year: '2026' }, changeType: 'C', lifecycle: 'cancellation' },
  ];
  for (const change of changes) for (const counter of [{ correction: 1 }, { sequence: 2 }, { sequence: 0, correction: 99 }]) {
    const after = record({ ...counter, ...change });
    for (const updates of [[before, after], [after, before]]) {
      const result = collectNotamRecords({ records: [] }, updates);
      assert.equal(result.records.length, 0, JSON.stringify({ change, counter }));
      assert.equal(result.issues?.length, 1);
    }
  }
});

test('counter provenance guards require bounded unique pairs including the representative pair', () => {
  const pairs = [{ sequence: 1, correction: 0 }, { sequence: 1, correction: 1 }];
  assert.ok(isNotamRecord(record({ sourceCounters: pairs })));
  for (const sourceCounters of [[], [pairs[0]], [pairs[0], pairs[0]],
    [{ sequence: 1, correction: 1 }, { sequence: 1, correction: 2 }],
    [{ sequence: 1, correction: 0 }, { sequence: -1, correction: 0 }],
    Array.from({ length: 9 }, (_, correction) => ({ sequence: 1, correction }))]) {
    assert.equal(isNotamRecord({ ...record(), sourceCounters }), false);
  }
});
