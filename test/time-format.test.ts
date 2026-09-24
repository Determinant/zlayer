import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDate, formatDateRange, formatTimestamp, formatTimestampPair, formatTimestampRange,
  formatAge, formatDataAge, formatCheckedAt } from '../src/core/format/time';

const now = Date.parse('2026-10-18T14:32:00Z');

test('calendar dates are compact, retain other years, and never shift with the device zone', () => {
  assert.equal(formatDate('2026-09-18', now), 'Sep 18');
  assert.equal(formatDate('2025-09-18', now), 'Sep 18, 2025');
  assert.equal(formatDate('2027-01-01', now), 'Jan 1, 2027');
  assert.equal(formatDateRange('2026-09-03', '2026-09-30', now), 'Sep 3–30');
  assert.equal(formatDateRange('2026-09-03', '2026-10-29', now), 'Sep 3–Oct 29');
  assert.equal(formatDateRange('2025-09-03', '2025-10-29', now), 'Sep 3–Oct 29, 2025');
  assert.equal(formatDateRange('2026-12-31', '2027-01-28', now), 'Dec 31, 2026–Jan 28, 2027');
  assert.equal(formatDateRange('2026-09-18', '2026-09-18', now), 'Sep 18');
  const previous = process.env.TZ;
  try {
    for (const zone of ['America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = zone;
      assert.equal(formatDate('2026-09-18', now), 'Sep 18');
      assert.equal(formatTimestamp('2026-09-18T00:00:00Z', { now }), 'Sep 18 · 00:00Z');
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('timestamps share date and 24-hour clock formats, with explicit UTC or local zones', () => {
  assert.equal(formatTimestamp('2026-09-18T14:32:59Z', { now }), 'Sep 18 · 14:32Z');
  assert.equal(formatTimestamp('2025-09-18T14:32:00Z', { now }), 'Sep 18, 2025 · 14:32Z');
  assert.equal(formatTimestamp('2026-09-18T07:32:00-07:00', { now }), 'Sep 18 · 14:32Z');
  assert.equal(formatTimestampRange('2026-09-18T14:00:00Z', '2026-09-18T20:00:00Z', { now }), 'Sep 18 · 14:00–20:00Z');
  assert.equal(formatTimestampRange('2026-09-18T18:00:00Z', '2026-09-19T18:00:00Z', { now }),
    'Sep 18 · 18:00Z – Sep 19 · 18:00Z');
  const local = { now, timeZone: 'America/Los_Angeles' };
  assert.equal(formatTimestamp('2026-09-18T00:00:00Z', local), 'Sep 17 · 17:00 PDT');
  assert.equal(formatTimestampRange('2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z', local),
    'Nov 1 · 01:30 PDT – Nov 1 · 01:30 PST');
  assert.equal(formatTimestampPair('2026-09-23T16:49:00Z', local), 'Sep 23 · 16:49Z / 09:49 PDT');
  assert.equal(formatTimestampPair('2026-09-23T00:30:00Z', local), 'Sep 23 · 00:30Z / Sep 22 · 17:30 PDT');
  assert.equal(formatTimestampPair('2026-11-01T09:30:00Z', local), 'Nov 1 · 09:30Z / 01:30 PST');
  assert.equal(formatTimestampPair('2027-01-01T00:30:00Z', local), 'Jan 1, 2027 · 00:30Z / Dec 31 · 16:30 PST');
});

test('currency ages round down, suppress zero remainders, and distinguish checks from source age', () => {
  for (const [milliseconds, expected] of [
    [0, '<1m'], [59_999, '<1m'], [60_000, '1m'], [3_599_999, '59m'],
    [3_600_000, '1h'], [5_400_000, '1h 30m'], [86_399_999, '23h 59m'],
    [86_400_000, '1d'], [30 * 86_400_000, '30d'],
  ] as const) assert.equal(formatAge(milliseconds), expected);
  assert.equal(formatDataAge('2026-09-18T14:32:00Z', now), '30d old');
  assert.equal(formatCheckedAt(now, now), 'Checked now');
  assert.equal(formatCheckedAt(now - 60_000, now), 'Checked 1m ago');
  assert.equal(formatCheckedAt(now - 86_400_000, now), 'Checked 1d ago');
});

test('invalid, missing and future times never become fresh-looking labels', () => {
  for (const value of [undefined, null, '', 'invalid', '2026-02-30', '2026-02-30T14:32:00Z', '2026-09-18T14:32:00', NaN, Infinity]) {
    assert.equal(formatDate(value, now), '—');
    assert.equal(formatTimestamp(value, { now }), '—');
    assert.equal(formatTimestampPair(value, { now }), '—');
    assert.equal(formatDataAge(value, now), 'Age unknown');
    assert.equal(formatCheckedAt(value, now), 'Check time unknown');
  }
  assert.equal(formatDataAge(now + 1, now), 'Future timestamp');
  assert.equal(formatCheckedAt(now + 1, now), 'Future check time');
  assert.equal(formatAge(-1), '—');
  assert.equal(formatDateRange('2026-09-19', '2026-09-18', now), '—');
  assert.equal(formatTimestampRange(now + 1, now), '—');
});
