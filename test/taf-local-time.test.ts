import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTafLocalTime } from '../src/layers/metar-taf/taf/local-time';

test('FM local times use the forecast instant, including daylight-saving jumps and repeated hours', () => {
  const options = { now: Date.parse('2026-09-18T00:00:00Z'), timeZone: 'America/Los_Angeles' };
  assert.equal(formatTafLocalTime('2026-03-08T09:30:00Z', options), 'Mar 8 · 01:30 PST');
  assert.equal(formatTafLocalTime('2026-03-08T10:30:00Z', options), 'Mar 8 · 03:30 PDT');
  assert.equal(formatTafLocalTime('2026-11-01T08:30:00Z', options), 'Nov 1 · 01:30 PDT');
  assert.equal(formatTafLocalTime('2026-11-01T09:30:00Z', options), 'Nov 1 · 01:30 PST');
});

test('device-zone dates can differ from UTC, including fractional offsets and year boundaries', () => {
  assert.equal(formatTafLocalTime('2027-01-01T01:00:00Z', { now: Date.parse('2026-09-18T00:00:00Z'), timeZone: 'America/Los_Angeles' }), 'Dec 31 · 17:00 PST');
  assert.equal(formatTafLocalTime('2026-09-17T19:00:00Z', { now: Date.parse('2026-09-18T00:00:00Z'), timeZone: 'Asia/Kathmandu' }), 'Sep 18 · 00:45 GMT+5:45');
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    assert.equal(formatTafLocalTime('2026-09-18T01:00:00Z', { now: Date.parse('2026-09-18T00:00:00Z') }), 'Sep 17 · 15:00 HST');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
