import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isMetarFeature, isTafReport, type FlightCategory, type MetarFeature, type TafReport } from '@zlayer/contracts';
import { metarAltimeter, metarSections } from '../src/metar.js';
import { metarWeatherProperties, parseVisibility } from '../src/weather.js';
import { tafReportLines } from '../src/taf.js';

type Provenance = { id: string; source: string; location: string; origin: string; note: string };
type Corpus = {
  sources: Record<string, { url: string; revision: string; license: string }>;
  metars: Array<Provenance & { properties: MetarFeature['properties']; expected: {
    ceilingStatus: string; ceilingFt: number | null; visibilitySm: number | null; category: FlightCategory | null;
    altimeter: { amount: number; unit: string; token: string } | null; remarks: string | null;
  } }>;
  tafs: Array<Provenance & { report: TafReport; expected: { categories: Array<FlightCategory | null>; fmTimes: Array<string | null> } }>;
  visibility: Array<{ value: string; expectedMiles: number | null; expectedCategory: FlightCategory | null }>;
};
const corpus: Corpus = JSON.parse(readFileSync(new URL('./fixtures/weather-decoder/cases.json', import.meta.url), 'utf8'));
const feature = (properties: MetarFeature['properties']): MetarFeature => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties,
});
const words = (text: string) => text.trim().replace(/\s+/g, ' ');

test('weather corpus cases have unique identities, pinned provenance and valid adapter inputs', () => {
  assert.ok(corpus.metars.length > 0 && corpus.tafs.length > 0 && corpus.visibility.length > 0);
  const ids = new Set<string>();
  for (const value of [...corpus.metars, ...corpus.tafs]) {
    assert.ok(!ids.has(value.id), value.id); ids.add(value.id);
    const source = corpus.sources[value.source];
    assert.ok(source?.url.startsWith('https://') && source.revision && source.license, value.id);
    assert.ok(value.location && value.origin && value.note, value.id);
    if ('report' in value) assert.ok(isTafReport(value.report), value.id);
    else assert.ok(isMetarFeature(feature(value.properties)), value.id);
  }
});

for (const { id, properties, expected } of corpus.metars) test(`METAR corpus: ${id}`, () => {
  const source = feature(structuredClone(properties)), before = structuredClone(source);
  const raw = source.properties.rawOb!, actual = metarWeatherProperties(source), setting = metarAltimeter(raw);
  assert.equal(actual.metarCeilingStatus, expected.ceilingStatus, 'ceiling certainty');
  assert.equal(actual.metarCeilingFt ?? null, expected.ceilingFt, 'ceiling feet');
  assert.equal(actual.metarVisibilitySm ?? null, expected.visibilitySm, 'visibility miles');
  assert.equal(actual.flightCategory ?? null, expected.category, 'category');
  assert.deepEqual(setting ? { amount: setting.amount, unit: setting.unit,
    token: raw.slice(setting.source.start, setting.source.end) } : null, expected.altimeter, 'pressure and source evidence');
  const sections = metarSections(raw);
  assert.equal(sections.map(section => raw.slice(section.start, section.end)).join(''), raw, 'complete unchanged source');
  const remarks = sections.find(section => section.kind === 'remarks');
  assert.equal(remarks ? raw.slice(remarks.start, remarks.end).trim() : null, expected.remarks, 'remarks boundary');
  assert.equal(actual.rawMetar, raw);
  assert.deepEqual(source, before, 'provider input is immutable');
});

for (const { id, report, expected } of corpus.tafs) test(`TAF corpus: ${id}`, () => {
  const before = structuredClone(report), lines = tafReportLines(report);
  assert.deepEqual(lines.map(line => line.category ?? null), expected.categories, 'reviewed period categories');
  assert.deepEqual(lines.map(line => line.fm?.time ?? null), expected.fmTimes, 'reviewed dated FM annotations');
  assert.equal(words(lines.map(line => line.text).join(' ')), words(report.rawTAF), 'every original word is visible');
  assert.deepEqual(report, before, 'raw text and provider fields are immutable');
});

for (const { value, expectedMiles, expectedCategory } of corpus.visibility) test(`weather corpus visibility: ${value}`, () => {
  assert.equal(parseVisibility(value) ?? null, expectedMiles);
  const actual = metarWeatherProperties(feature({ rawOb: 'METAR KAAA 171800Z BKN050', visib: value }));
  assert.equal(actual.metarVisibilitySm ?? null, expectedMiles, 'display distance');
  assert.equal(actual.flightCategory ?? null, expectedCategory, 'unknown visibility cannot imply VFR from a high ceiling');
  const from = Date.parse('2026-09-17T18:00:00Z') / 1000;
  const lines = tafReportLines({ icaoId: 'KAAA', issueTime: '2026-09-17T17:00:00Z', validTimeFrom: from,
    validTimeTo: from + 86400, rawTAF: 'TAF KAAA 171700Z 1718/1818 BKN050',
    fcsts: [{ timeFrom: from, timeTo: from + 86400, visib: value, clouds: [{ cover: 'BKN', base: 5000 }] }] });
  // Numeric exponent notation belongs to the METAR provider contract only.
  assert.equal(lines[0]!.category ?? null, value === '1e0' ? null : expectedCategory, 'TAF visibility validation');
});

test('damaged cloud groups preserve restrictions and provider precedence without guessing heights', () => {
  for (const [clouds, category] of [['BKN004 BKN09', 'LIFR'], ['BKN008 0VC003', 'IFR'], ['FEW001 0VC003', undefined]] as const) {
    const rawOb = `METAR KAAA 171800Z 10SM ${clouds}`;
    const actual = metarWeatherProperties(feature({ rawOb, visib: 10 }));
    assert.equal(actual.metarCeilingStatus, 'unknown');
    assert.equal(actual.metarCeilingFt, undefined);
    assert.equal(actual.flightCategory, category, clouds);
    assert.equal(metarWeatherProperties(feature({ rawOb, visib: 10, ceil: 8 })).metarCeilingFt, 800);
    assert.equal(metarWeatherProperties(feature({ rawOb, visib: 10, fltcat: 'MVFR' })).flightCategory, 'MVFR');
  }
  const from = Date.parse('2026-09-17T18:00:00Z') / 1000;
  for (const cloud of ['BKN09', '0VC003']) {
    const report: TafReport = { icaoId: 'KAAA', issueTime: '2026-09-17T17:00:00Z', validTimeFrom: from,
      validTimeTo: from + 86400, rawTAF: `TAF KAAA 171700Z 1718/1818 P6SM SCT030 ${cloud}`,
      fcsts: [{ timeFrom: from, timeTo: from + 86400, visib: '6+', clouds: [{ cover: 'SCT', base: 3000 }] }] };
    assert.equal(tafReportLines(report)[0]!.category, undefined, cloud);
  }
});

test('known restrictions survive missing or invalid visibility without asserting VFR', () => {
  for (const fields of [{}, { visib: null }, { visib: -1 }, { visib: '11/2' }, { visib: '1/0' }]) {
    assert.equal(metarWeatherProperties(feature({ rawOb: 'METAR KAAA 171800Z BKN004', ...fields })).flightCategory, 'LIFR');
    assert.equal(metarWeatherProperties(feature({ rawOb: 'METAR KAAA 171800Z BKN050', ...fields })).flightCategory, undefined);
    assert.equal(metarWeatherProperties(feature({ rawOb: 'METAR KAAA 171800Z BKN050', ...fields, fltcat: 'IFR' })).flightCategory, 'IFR');
  }
});

test('documented damaged change markers stay opaque inside remarks', () => {
  const base = corpus.tafs.find(value => value.id === 'avwx-taf-temp0')!.report;
  const rawTAF = 'TAF KAAA 171700Z 1718/1818 P6SM SCT030 RMK TEMP0 1719/1720 BEMG T EMPO 1/2SM';
  const lines = tafReportLines({ ...base, rawTAF });
  assert.deepEqual(lines.map(line => line.category), ['VFR', undefined]);
  assert.equal(lines.map(line => line.text).join(' '), rawTAF);
});
