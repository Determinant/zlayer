import assert from 'node:assert/strict';
import test from 'node:test';
import type { MetarFeature, TafForecast, TafReport } from '@zlayer/contracts';
import { metarAltimeter, metarSections } from '../src/metar.js';
import { metarWeatherProperties } from '../src/weather.js';
import { parseTafGroups } from '../src/taf-parser.js';
import { tafReportLines } from '../src/taf.js';

const from = Date.parse('2026-09-17T18:00:00Z') / 1000;
const forecast = (fields: Partial<TafForecast> = {}): TafForecast => ({ timeFrom: from, timeTo: from + 86400,
  visib: '6+', clouds: [{ cover: 'SCT', base: 3000 }], ...fields });
const report = (rawTAF: string, fcsts: TafForecast[] = [forecast()]): TafReport => ({ icaoId: 'KAAA',
  issueTime: '2026-09-17T17:00:00Z', validTimeFrom: from, validTimeTo: from + 86400, rawTAF, fcsts });
const observation = (rawOb: string, properties: MetarFeature['properties'] = {}): MetarFeature => ({ type: 'Feature',
  geometry: { type: 'Point', coordinates: [0, 0] }, properties: { rawOb, ...properties } });
const metarPrefix = 'METAR KAAA 171800Z 24010KT 10SM ';
const tafPrefix = 'TAF KAAA 171700Z 1718/1818 P6SM SCT030 ';

test('METAR cloud and pressure extraction share irreversible observation, trend, remark and end boundaries', () => {
  for (const boundary of ['TEMPO', 'BECMG', 'NOSIG', 'RMK', '=', 'rmk']) {
    const raw = `${metarPrefix}${boundary} OVC002 A2992`;
    const decoded = metarWeatherProperties(observation(raw));
    assert.equal(decoded.metarCeilingFt, undefined, boundary);
    assert.equal(decoded.metarCeilingStatus, 'unknown', boundary);
    assert.equal(metarAltimeter(raw), undefined, boundary);
    const retained = `${metarPrefix}BKN008 Q1013 ${boundary} OVC002 A2992`;
    assert.equal(metarWeatherProperties(observation(retained)).metarCeilingFt, 800, boundary);
    assert.equal(metarAltimeter(retained)?.amount, 1013, boundary);
  }
  // Control-looking words in remarks never reopen observation or trend parsing.
  const raw = `${metarPrefix}BKN008 A2992 RMK TEMPO BECMG METAR OVC001 Q0980`;
  assert.deepEqual(metarSections(raw).map(section => section.kind), ['observation', 'remarks']);
  assert.equal(metarWeatherProperties(observation(raw)).metarCeilingFt, 800);
  assert.equal(metarAltimeter(raw)?.amount, 29.92);
});

test('METAR fields retain source evidence, missing heights, units and decoded-field precedence', () => {
  const raw = `  metar KAAA 171800Z 10SM bkn/// ovc008 q0995=\n METAR KBBB BKN001 A3000`;
  const setting = metarAltimeter(raw)!;
  assert.equal(raw.slice(setting.source.start, setting.source.end), 'q0995');
  assert.equal(setting.amount, 995); assert.equal(setting.unit, 'hPa');
  const decoded = metarWeatherProperties(observation(raw, { visib: 10 }));
  assert.equal(decoded.metarCeilingFt, undefined);
  assert.equal(decoded.metarCeilingStatus, 'unknown');
  assert.equal(decoded.flightCategory, 'IFR', 'the known 800 ft layer bounds an otherwise unknown ceiling');
  assert.equal(metarWeatherProperties(observation(raw, { ceil: 20, fltcat: 'MVFR' })).metarCeilingFt, 2000);
  assert.equal(metarWeatherProperties(observation(raw, { fltcat: 'MVFR' })).flightCategory, 'MVFR');
  for (const token of ['NOTA2992', 'A29921', 'A////', 'Q0000']) assert.equal(metarAltimeter(metarPrefix + token), undefined, token);
});

test('TAF probability headers consume their probability, optional qualifier and complete interval atomically', () => {
  for (const [prefix, probability] of [['PROB30 TEMPO', 30], ['prob\n30\ninter', 30], ['PROB40', 40], ['PROB 40 TEMPO', 40]] as const) {
    const raw = `${tafPrefix}${prefix} 1718 /\n1720 2SM FM 172000 P6SM SCT030`;
    const source = report(raw, [forecast(), forecast({ fcstChange: 'PROB', probability, timeTo: from + 7200, visib: 2, clouds: [] }),
      forecast({ fcstChange: 'FM', timeFrom: from + 7200 })]);
    const before = JSON.stringify(source), lines = tafReportLines(source);
    assert.deepEqual(lines.map(line => line.category), ['VFR', 'IFR', 'VFR'], prefix);
    assert.equal(lines[1]!.text, `${prefix} 1718 /\n1720 2SM`);
    assert.deepEqual(lines[2]!.fm, { token: 'FM 172000', time: '2026-09-17T20:00:00.000Z' });
    assert.equal(JSON.stringify(source), before);
  }
});

test('malformed TAF change headers preserve every word and cannot borrow another group or decoded category', () => {
  for (const tail of ['PROB50 1718/1720 2SM', 'PROB 50 TEMPO 1718/1720 2SM', 'PROB TEMPO 1718/1720 2SM',
    'PROB30 TEMPO 1718/ 2SM', 'PROB30 FM172000 SCT030', 'TEMPO1718/1720 2SM', 'BECMG123 1718/1720 SCT030',
    'FM1720 SCT030', 'FM172000X SCT030', 'FM SCT030', 'FM 172000', 'TEMPO 1718/1720=']) {
    const raw = tafPrefix + tail;
    // Even an upstream decoder that omits the malformed group cannot color the initial line.
    const source = report(raw), lines = tafReportLines(source);
    assert.ok(lines.length > 0);
    assert.ok(lines.every(line => line.category === undefined && line.fm === undefined), tail);
    assert.equal(lines.map(line => line.text).join(' '), raw, tail);
    assert.equal(parseTafGroups(raw).complete, false, tail);
  }
});

test('TAF remarks and report terminators cannot introduce or modify forecast periods', () => {
  const raw = `${tafPrefix}RMK FM172000 CAVOK PROB30 TEMPO 1718/1720 1/2SM`;
  const lines = tafReportLines(report(raw));
  assert.deepEqual(lines.map(line => line.category), ['VFR', undefined]);
  assert.equal(lines[1]!.text, 'RMK FM172000 CAVOK PROB30 TEMPO 1718/1720 1/2SM');
  assert.deepEqual(tafReportLines(report(`${tafPrefix.trimEnd()}= RMK FM172000 CAVOK`)).map(line => line.category), ['VFR', undefined]);
  const joined = `${tafPrefix.trimEnd()}= FM172000 P6SM SCT030`;
  const mismatched = tafReportLines(report(joined, [forecast(), forecast({ fcstChange: 'FM', timeFrom: from + 7200 })]));
  assert.ok(mismatched.every(line => line.category === undefined && !line.fm));
  assert.equal(mismatched.map(line => line.text).join(' '), joined);
});

test('FM resets omitted conditions while temporary conditions stay confined to their overlapping baselines', () => {
  const source = report(`${tafPrefix}TEMPO 1718/1722 2SM FM172000 24010KT`, [
    forecast(), forecast({ fcstChange: 'TEMPO', timeTo: from + 14400, visib: 2, clouds: [] }),
    forecast({ fcstChange: 'FM', timeFrom: from + 7200, visib: '', clouds: [] }),
  ]);
  assert.deepEqual(tafReportLines(source).map(line => line.category), ['VFR', undefined, undefined]);
});

test('source sections cover captured wording exactly, including wrapping, remarks and end markers', () => {
  for (const raw of [` \n${metarPrefix}BKN008 A2992\nTEMPO 2000 RMK BKN001=  `,
    `\n${tafPrefix}PROB 30 TEMPO 1718 / 1720 2SM\nFM 172000 SCT030= RMK Q1013 \n`]) {
    for (const sections of [metarSections(raw), parseTafGroups(raw).groups]) {
      let end = 0;
      for (const section of sections) {
        assert.equal(section.start, end);
        assert.ok(section.end > section.start);
        for (const token of section.tokens) {
          assert.ok(token.start >= section.start && token.end <= section.end);
          assert.equal(raw.slice(token.start, token.end).toUpperCase(), token.value);
        }
        end = section.end;
      }
      assert.equal(end, raw.length);
      assert.equal(sections.map(section => raw.slice(section.start, section.end)).join(''), raw);
    }
  }
});

test('bounded interpretation keeps over-limit reports intact and never publishes partial fields or colors', () => {
  const atGroupLimit = tafPrefix + 'FM172000 P6SM SCT030 '.repeat(127);
  assert.equal(parseTafGroups(atGroupLimit).groups.length, 128);
  assert.equal(parseTafGroups(atGroupLimit).complete, true);
  for (const raw of [tafPrefix + 'X'.repeat(65536), tafPrefix + 'X '.repeat(4096),
    tafPrefix + 'FM172000 P6SM SCT030 '.repeat(129), atGroupLimit + 'RMK TEST', atGroupLimit + '= FM172100 SCT030']) {
    const parsed = parseTafGroups(raw), lines = tafReportLines(report(raw));
    assert.equal(parsed.complete, false);
    assert.deepEqual(lines, [{ text: raw.trim(), category: undefined }]);
  }
  for (const raw of [metarPrefix + 'A2992 BKN008 ' + 'X'.repeat(65536), metarPrefix + 'A2992 BKN008 ' + 'X '.repeat(4096)]) {
    assert.equal(metarAltimeter(raw), undefined);
    assert.equal(metarWeatherProperties(observation(raw)).metarCeilingStatus, 'unknown');
    assert.equal(metarWeatherProperties(observation(raw, { ceil: 8 })).metarCeilingFt, 800, 'decoded fields remain usable');
  }
});
