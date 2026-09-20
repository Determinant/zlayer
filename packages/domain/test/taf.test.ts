import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isTafReport, type TafReport, type TafForecast } from '@zlayer/contracts';
import { tafReportLines } from '../src/taf.js';

const start = Date.parse('2026-09-17T18:00:00Z') / 1000;
function forecast(fields: Partial<TafForecast> = {}): TafForecast {
  return { timeFrom: start, timeTo: start + 24 * 3600, visib: '6+', clouds: [{ cover: 'SCT', base: 2000 }], ...fields };
}
function report(rawTAF: string, fcsts: TafForecast[]): TafReport {
  return { icaoId: 'KTEST', issueTime: '2026-09-17T17:20:00Z', validTimeFrom: start,
    validTimeTo: start + 24 * 3600, rawTAF, fcsts };
}
const categories = (value: TafReport) => tafReportLines(value).map(line => line.category);

test('live AWC fixtures retain every raw token and match forecast colors, including combined PROB TEMPO', () => {
  const { reports } = JSON.parse(readFileSync(new URL('./fixtures/tafs.json', import.meta.url), 'utf8'));
  const expected = { EGLL: ['VFR', 'VFR'], KJFK: ['VFR', 'VFR', 'MVFR', 'VFR', 'MVFR', 'VFR', 'VFR'],
    KSFO: ['MVFR', 'VFR', 'VFR', 'MVFR', 'VFR', 'VFR'] };
  for (const value of reports) {
    assert.ok(isTafReport(value));
    assert.deepEqual(categories(value), expected[value.icaoId as keyof typeof expected]);
    assert.equal(tafReportLines(value).map(line => line.text).join(' '), value.rawTAF);
  }
});

test('TAF ceilings are feet, category boundaries are inclusive, and the worse element wins', () => {
  for (const [ceiling, visibility, expected] of [
    [499, 10, 'LIFR'], [500, 10, 'IFR'], [999, 10, 'IFR'], [1000, 10, 'MVFR'],
    [3000, 10, 'MVFR'], [3001, 10, 'VFR'], [5000, 0.99, 'LIFR'], [5000, 1, 'IFR'],
    [5000, 2.99, 'IFR'], [5000, 3, 'MVFR'], [5000, 5, 'MVFR'], [5000, 5.01, 'VFR'],
    [800, 5, 'IFR'], [2000, '1/2', 'LIFR'], [2000, '1 1/2', 'IFR'],
    [5000, 'M1', 'LIFR'], [5000, 'M3', 'IFR'], [5000, 'P5', 'VFR'],
  ] as const) {
    assert.equal(categories(report('TAF TEST', [forecast({ visib: visibility, clouds: [{ cover: 'BKN', base: ceiling }] })]))[0], expected);
  }
  assert.equal(categories(report('TAF TEST VV002', [forecast({ vertVis: 200, clouds: [] })]))[0], 'LIFR');
  assert.equal(categories(report('TAF TEST CAVOK', [forecast({ visib: '', clouds: [] })]))[0], 'VFR');
});

test('temporary conditions inherit missing elements, without changing subsequent prevailing weather', () => {
  const value = report('TAF TEST BKN008 TEMPO 1718/1720 1/2SM PROB30 1719/1720 02015KT FM172000 03010KT P6SM SCT020', [
    forecast({ clouds: [{ cover: 'BKN', base: 800 }], timeTo: start + 2 * 3600 }),
    forecast({ fcstChange: 'TEMPO', timeTo: start + 2 * 3600, visib: 0.5, clouds: [] }),
    forecast({ fcstChange: 'PROB', probability: 30, timeFrom: start + 3600, timeTo: start + 2 * 3600, visib: '', clouds: [] }),
    forecast({ fcstChange: 'FM', timeFrom: start + 2 * 3600 }),
  ]);
  assert.deepEqual(categories(value), ['IFR', 'LIFR', 'IFR', 'VFR']);
});

test('partial temporary periods spanning a new FM account for the more restrictive baseline', () => {
  const value = report('TAF TEST SCT020 TEMPO 1718/1722 3SM FM172000 BKN003', [
    forecast({ timeTo: start + 2 * 3600 }),
    forecast({ fcstChange: 'TEMPO', timeTo: start + 4 * 3600, visib: 3, clouds: [] }),
    forecast({ fcstChange: 'FM', timeFrom: start + 2 * 3600, clouds: [{ cover: 'BKN', base: 300 }] }),
  ]);
  assert.deepEqual(categories(value), ['VFR', 'LIFR', 'LIFR']);
});

test('BECMG inherits unchanged visibility, replaces clouds, and persists into later partial forecasts', () => {
  const value = report('TAF TEST BKN008 BECMG 1719/1720 SCT030 TEMPO 1721/1722 02020KT', [
    forecast({ clouds: [{ cover: 'BKN', base: 800 }] }),
    forecast({ fcstChange: 'BECMG', timeFrom: start + 3600, timeBec: start + 2 * 3600, visib: '', clouds: [{ cover: 'SCT', base: 3000 }] }),
    forecast({ fcstChange: 'TEMPO', timeFrom: start + 3 * 3600, timeTo: start + 4 * 3600, visib: '', clouds: [] }),
  ]);
  assert.deepEqual(categories(value), ['IFR', 'VFR', 'VFR']);
});

test('unknown, undecodable, cancelled and misaligned forecasts remain neutral', () => {
  for (const value of [
    report('TAF TEST VV///', [forecast({ clouds: [{ cover: 'VV', base: null }] })]),
    report('TAF TEST', [forecast({ clouds: [] })]),
    report('TAF TEST', [forecast({ visib: null })]),
    report('TAF TEST', [forecast({ visib: '500M' })]),
    report('TAF TEST CNL', [forecast()]),
    report('TAF TEST NIL', []),
    report('TAF TEST FM172000', [forecast()]),
    report('TAF TEST FM172000', [forecast(), forecast({ fcstChange: 'FM', timeFrom: start + 3600 })]),
  ]) assert.ok(categories(value).every(category => category === undefined));
  const value = report('TAF TEST SCT020 RMK NEXT FCST BY 180000Z', [forecast()]);
  assert.deepEqual(categories(value), ['VFR', undefined]);
  assert.equal(tafReportLines(value)[1]?.text, 'RMK NEXT FCST BY 180000Z');
});

test('partial temporary changes during BECMG account for both sides of the transition', () => {
  const value = report('TAF TEST SCT030 BECMG 1719/1721 BKN003 TEMPO 1719/1720 02020KT', [
    forecast(),
    forecast({ fcstChange: 'BECMG', timeFrom: start + 3600, timeBec: start + 3 * 3600, visib: '', clouds: [{ cover: 'BKN', base: 300 }] }),
    forecast({ fcstChange: 'TEMPO', timeFrom: start + 3600, timeTo: start + 2 * 3600, visib: '', clouds: [] }),
  ]);
  assert.deepEqual(categories(value), ['VFR', 'LIFR', 'LIFR']);
});

test('Australian INTER groups match AWC TEMPO periods without changing the original report', () => {
  const { reports } = JSON.parse(readFileSync(new URL('./fixtures/tafs-inter.json', import.meta.url), 'utf8'));
  const expected = { YBCS: ['VFR', 'VFR', 'MVFR', 'IFR'], YPPH: ['VFR', 'VFR', 'MVFR', 'MVFR', 'IFR', 'IFR'] };
  for (const value of reports) {
    assert.ok(isTafReport(value));
    assert.deepEqual(categories(value), expected[value.icaoId as keyof typeof expected]);
    assert.equal(tafReportLines(value).map(line => line.text).join(' '), value.rawTAF);
  }
});

test('wrapped groups, spaced slashes, case variations and combined probability groups retain their colors', () => {
  const raw = 'taf amd TEST P6SM BKN008\n  prob30\ninter 1718 / 1720 1/2SM\nfm 172000 03010KT P6SM SCT020\nrmk nxt fcst by 180000z=';
  const value = report(raw, [
    forecast({ clouds: [{ cover: 'bkn', base: 800 }], timeTo: start + 2 * 3600 }),
    forecast({ fcstChange: 'PROB', probability: 30, timeTo: start + 2 * 3600, visib: '1/2', clouds: [] }),
    forecast({ fcstChange: 'fm', timeFrom: start + 2 * 3600 }),
  ]);
  assert.deepEqual(categories(value), ['IFR', 'LIFR', 'VFR', undefined]);
  assert.deepEqual(tafReportLines(value)[2]?.fm, { token: 'fm 172000', time: '2026-09-17T20:00:00.000Z' });
  assert.equal(tafReportLines(value).map(line => line.text).join(' ').replace(/\s+/g, ' '), raw.replace(/\s+/g, ' '));
});

test('period matching checks the end time and probability, and does not guess invalid FM times', () => {
  for (const [text, change] of [
    ['TEMPO 1718/1720 2SM', forecast({ fcstChange: 'TEMPO', timeTo: start + 3 * 3600, visib: 2 })],
    ['PROB30 1718/1720 2SM', forecast({ fcstChange: 'PROB', probability: 40, timeTo: start + 2 * 3600, visib: 2 })],
    ['FM172500 SCT020', forecast({ fcstChange: 'FM', timeFrom: start + 7 * 3600 })],
    ['FM171960 SCT020', forecast({ fcstChange: 'FM', timeFrom: start + 2 * 3600 })],
  ] as const) {
    const lines = tafReportLines(report(`TAF TEST SCT020 ${text}`, [forecast(), change]));
    assert.ok(lines.every(line => line.category === undefined && !line.fm));
  }
});

test('FM annotations use decoded dates across month/year rollover and DD24 matches midnight', () => {
  const dec31 = Date.parse('2026-12-31T18:00:00Z') / 1000;
  const jan1 = Date.parse('2027-01-01T00:00:00Z') / 1000;
  const value = { ...report('TAF TEST SCT020 TEMPO 3118/3124 2SM FM010030 SCT020', []),
    validTimeFrom: dec31, validTimeTo: jan1 + 18 * 3600,
    fcsts: [forecast({ timeFrom: dec31, timeTo: jan1 + 1800 }),
      forecast({ fcstChange: 'TEMPO', timeFrom: dec31, timeTo: jan1, visib: 2 }),
      forecast({ fcstChange: 'FM', timeFrom: jan1 + 1800, timeTo: jan1 + 18 * 3600 })] };
  assert.deepEqual(categories(value), ['VFR', 'IFR', 'VFR']);
  assert.equal(tafReportLines(value)[2]?.fm?.time, '2027-01-01T00:30:00.000Z');
  const monthEnd = { ...value, rawTAF: 'TAF TEST SCT020 FM010030 SCT020',
    validTimeFrom: Date.parse('2026-09-30T18:00:00Z') / 1000, validTimeTo: Date.parse('2026-10-01T18:00:00Z') / 1000,
    fcsts: [forecast({ timeFrom: Date.parse('2026-09-30T18:00:00Z') / 1000, timeTo: Date.parse('2026-10-01T00:30:00Z') / 1000 }),
      forecast({ fcstChange: 'FM', timeFrom: Date.parse('2026-10-01T00:30:00Z') / 1000, timeTo: Date.parse('2026-10-01T18:00:00Z') / 1000 })] };
  assert.equal(tafReportLines(monthEnd)[1]?.fm?.time, '2026-10-01T00:30:00.000Z');
});
