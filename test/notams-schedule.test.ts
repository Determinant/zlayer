import assert from 'node:assert/strict';
import test from 'node:test';
import { notamValidity } from '../src/layers/notams/validity';
import { parseNotamSchedule, equalNotamSchedules } from '../src/layers/notams/schedule';
import { collectNotamRecords } from '../tools/info-server/notams/collection';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { notice } from './fixtures/notams';

const record = (schedule: string) => recordWithRevision({ ...notice(), schedule,
  startsAt: Date.parse('2026-10-01T00:00:00Z'), endsAt: Date.parse('2026-11-01T00:00:00Z'),
  effectiveStart: '202610010000', effectiveEnd: '202611010000' });
const validity = (schedule: string, at: string) => notamValidity(record(schedule), Date.parse(at));

test('every weekday wrapper has the same collection and timing meaning as its readable source', () => {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const codes = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  for (let i = 0; i < names.length; i++) {
    const raw = `${names[i]}:1830-1930~${codes[i]} 1830-1930`, plain = `${codes[i]} 1830-1930`;
    const variants = [record(raw), record(plain)];
    for (const order of [variants, [...variants].reverse()]) {
      const collection = collectNotamRecords({ records: [order[0]!] }, order.slice(1));
      assert.equal(collection.issues?.length ?? 0, 0, raw);
      assert.equal(collection.records[0]?.schedule, order[0]!.schedule, 'retain source spelling');
      assert.equal(collection.records[0]?.updatedAt, order[0]!.updatedAt);
      assert.equal(collectNotamRecords(collection, [...variants, ...variants]), collection);
    }
    for (const schedule of [raw, plain]) {
      const date = `2026-10-${11 + i}`; // Sunday through Saturday.
      for (const [time, expected] of [['18:29:59', 'outside schedule'], ['18:30:00', 'within interval'],
        ['19:29:59', 'within interval'], ['19:30:00', 'outside schedule']] as const) {
        assert.equal(validity(schedule, `${date}T${time}Z`), expected, schedule);
      }
      assert.equal(validity(schedule, `2026-10-${12 + i}T18:45:00Z`), 'outside schedule');
    }
  }
});

test('weekday lists, ranges and all-week spellings share meaning without broadening their windows', () => {
  for (const pair of [
    ['FRI-MON 2200-0200', 'MON FRI SAT SUN 2200-0200'],
    ['MON-FRI 0900-1700', 'MON TUE WED THU FRI 0900-1700'],
    ['Daily:0000-2400~DLY 0000-2400', 'SUN-SAT 0000-2400'],
  ]) {
    const [a, b] = pair as [string, string];
    assert.ok(equalNotamSchedules(parseNotamSchedule(a), parseNotamSchedule(b)));
    for (const order of [[a, b], [b, a]]) {
      assert.equal(collectNotamRecords({ records: [] }, order.map(record)).issues?.length ?? 0, 0);
    }
    for (const at of ['2026-10-09T21:59:59Z', '2026-10-09T22:00:00Z', '2026-10-10T01:59:59Z',
      '2026-10-10T02:00:00Z', '2026-10-13T01:00:00Z', '2026-10-13T22:00:00Z']) {
      assert.equal(validity(a, at), validity(b, at), at);
    }
  }
  for (const schedule of ['FRI-MON 2200-0200', 'MON FRI SAT SUN 2200-0200']) {
    assert.equal(validity(schedule, '2026-10-09T21:59:59Z'), 'outside schedule');
    assert.equal(validity(schedule, '2026-10-09T22:00:00Z'), 'within interval');
    assert.equal(validity(schedule, '2026-10-13T01:00:00Z'), 'within interval');
    assert.equal(validity(schedule, '2026-10-13T02:00:00Z'), 'outside schedule');
    assert.equal(validity(schedule, '2026-10-13T22:00:00Z'), 'outside schedule');
  }
  assert.equal(validity('MON 0000-2400', '2026-10-12T23:59:59Z'), 'within interval');
  assert.equal(validity('MON 0000-2400', '2026-10-13T00:00:00Z'), 'outside schedule');
});

test('absence, partial days and opaque assertions stay distinct in timing and reconciliation', () => {
  assert.equal(validity('', '2026-10-07T18:45:00Z'), 'within interval');
  assert.equal(validity('WED', '2026-10-07T18:45:00Z'), 'check schedule');
  assert.equal(collectNotamRecords({ records: [] }, [record('WED'), record('WED 1830-1930')]).issues?.length, 1,
    'partial metadata cannot supply hours without a complete native witness');
  for (const opaque of ['SR-SS', 'Daily:SR-SS~DLY SR-SS', 'H24',
    'Wednesday:1830-1930~THU 1830-1930', 'Wednesday:1830-1930~WED 1830-1940',
    'Wednesday:1830-1930~WED', 'Wednesday:1830-1930~WED 1830-1930~WED 1830-1930',
    'Daily:1518-2241~DLY SR-SS', 'Daily:1830-1930~WED 1830-1930',
    'WED 2460-2500', 'WED 2400-0100', 'WED 1830-2460', 'WED 1830-1830',
    'WED 1830-1930 EXC HOL', 'WED 1830-1930 2000-2100', 'WED 1830-1930 THU 2000-2100']) {
    assert.equal(parseNotamSchedule(opaque).kind, 'opaque', opaque);
    assert.equal(validity(opaque, '2026-10-07T18:45:00Z'), 'check schedule', opaque);
    const variants = [record(opaque), record('WED 1830-1930')];
    for (const order of [variants, [...variants].reverse()]) {
      const conflict = collectNotamRecords({ records: [] }, order);
      assert.equal(conflict.issues?.length, 1, opaque);
      assert.equal(collectNotamRecords(conflict, [record(''), ...variants]).issues?.length, 1,
        'omissions and replay cannot erase an unsupported assertion');
    }
    // Exact unknown source text can be retained without claiming interpretation.
    assert.equal(collectNotamRecords({ records: [] }, [record(opaque), record(opaque)]).records.length, 1);
  }
});
