import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MetarFeature } from '@zlayer/contracts';
import { metarWeatherProperties } from '@zlayer/domain';
import capturedMetars from './fixtures/nws/metars-noaa.json' with { type: 'json' };
import { MetarReportView } from '../src/layers/metar-taf/metar/report';
import { formatMetarAltimeter, formatMetarWind } from '../src/layers/metar-taf/metar/format';
import { metarDetailRows } from '../src/layers/metar-taf/metar/details';

const now = Date.parse('2026-09-17T18:00:00Z');

test('METAR wind shows magnetic/true bearings with east/west variation and north wraparound', () => {
  for (const [direction, declination, expected] of [
    [340, 13, '327°M/340°T'], ['340', -13, '353°M/340°T'],
    [5, 13, '352°M/005°T'], [355, -12, '007°M/355°T'],
    [0, 0, '360°M/360°T'], [360, 0.4, '360°M/360°T'],
  ] as const) {
    assert.equal(formatMetarWind({ metarWindDirection: direction, metarWindSpeedKt: 6, metarWindGustKt: 12 }, declination),
      `${expected} 6G12 kt`);
  }
});

test('METAR wind keeps missing magnetic references, calm and variable directions explicit', () => {
  for (const declination of [undefined, null, NaN, Infinity]) {
    assert.equal(formatMetarWind({ metarWindDirection: 340, metarWindSpeedKt: 6 }, declination), '—/340°T 6 kt');
  }
  assert.equal(formatMetarWind({ metarWindDirection: 0, metarWindSpeedKt: 0 }, 13), 'Calm');
  assert.equal(formatMetarWind({ metarWindDirection: 'VRB', metarWindSpeedKt: 6 }, 13), 'VRB 6 kt');
  assert.equal(formatMetarWind({ metarWindSpeedKt: 6 }, 13), 'Direction unavailable · 6 kt');
  assert.equal(formatMetarWind({ metarWindDirection: 361, metarWindSpeedKt: 6 }, 13), 'Direction unavailable · 6 kt');
  assert.equal(formatMetarWind({ metarWindDirection: 340 }, 13), undefined);
});

test('the METAR section always presents the selected report ceiling, including cached observations', () => {
  const cases: [MetarFeature['properties'], string][] = [
    [{ ceil: 9, cover: 'OVC' }, '900 ft'],
    [{ ceil: 0 }, '0 ft'],
    [{ clouds: [{ cover: 'SCT', base: 3 }, { cover: 'BKN', base: 12 }] }, '1,200 ft'],
    [{ rawOb: 'METAR KHAF 171800Z 28010KT 4SM BR OVC009' }, '900 ft'],
    [{ ceil: null, cover: 'CLR' }, 'None reported'],
    [{ rawOb: 'METAR KHAF 171800Z 28010KT 4SM BR VV///' }, 'Unknown'],
    [{}, 'Unknown'],
  ];
  for (const [properties, ceiling] of cases) {
    for (const online of [true, false]) {
      const report: MetarFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.5, 37.5] },
        properties: { id: 'KHAF', obsTime: now / 1000, ...properties } };
      const html = renderToStaticMarkup(createElement(MetarReportView, {
        entry: { report, checkedAt: now }, loading: false, online, now,
      }));
      assert.ok(html.includes(`<dt>Ceiling</dt><dd>${ceiling}</dd>`), html);
    }
  }
});

test('the METAR card leaves unknown ceilings explicit without losing a known category restriction', () => {
  for (const [sky, category] of [['VV///', 'N/A'], ['BKN/// OVC008', 'IFR']]) {
    const report: MetarFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.5, 37.5] },
      properties: { id: 'KHAF', obsTime: now / 1000, visib: 10, rawOb: `METAR KHAF 171800Z 10SM ${sky}` } };
    const html = renderToStaticMarkup(createElement(MetarReportView, {
      entry: { report, checkedAt: now }, loading: false, online: true, now,
    }));
    assert.ok(html.includes('<dt>Ceiling</dt><dd>Unknown</dd>'), html);
    assert.ok(!html.includes('<dt>Flight category</dt>'), html);
    assert.ok(html.includes(`data-flight-category="${category === 'N/A' ? 'unknown' : category}"`), html);
  }
});

test('METAR altimeter preserves reported units and never substitutes remarks or malformed groups', () => {
  for (const [raw, expected] of [
    ['METAR KSFO 171800Z 28010KT 10SM CLR 20/10 A2992 RMK AO2 SLP132', '29.92 inHg'],
    ['METAR KSFO 171800Z A3000=', '30.00 inHg'],
    ['METAR EGLL 171800Z 24010KT CAVOK 18/12 Q0995=', '995 hPa'],
    ['METAR EGLL 171800Z Q1013 NOSIG', '1013 hPa'],
    ['METAR KSFO 171800Z RMK A2992 SLP132', undefined],
    ['METAR KSFO 171800Z rmk A2992', undefined],
    ['METAR KSFO 171800Z TEMPO A2992', undefined],
    ['METAR KSFO 171800Z= METAR KJFK A2992', undefined],
    ['metar egll 171800z q1013 rmk Q0995', '1013 hPa'],
    ['METAR KSFO 171800Z A//// RMK AO2', undefined],
    ['METAR KSFO 171800Z A29921', undefined],
    ['METAR KSFO 171800Z Q0000', undefined],
    [undefined, undefined],
  ] as const) assert.equal(formatMetarAltimeter(raw), expected, raw);
});

test('captured US and international METARs retain observed sky conditions and pressure through the shared parser', () => {
  const expected: Record<string, [string, number | undefined]> = {
    PHNL: ['29.97 inHg', undefined], KLAX: ['29.84 inHg', undefined], KSBA: ['29.83 inHg', undefined],
    EGLL: ['1026 hPa', undefined], PAFA: ['29.93 inHg', 5000], KSFO: ['29.90 inHg', undefined], CYVR: ['30.11 inHg', undefined],
  };
  assert.equal(capturedMetars.features.length, Object.keys(expected).length);
  for (const { properties: source } of capturedMetars.features) {
    const raw = source.rawdata, [altimeter, ceiling] = expected[source.stationname]!;
    const report: MetarFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { rawOb: raw } };
    const original = JSON.stringify(report), decoded = metarWeatherProperties(report);
    assert.equal(formatMetarAltimeter(raw), altimeter, source.stationname);
    assert.equal(decoded.metarCeilingFt, ceiling, source.stationname);
    assert.equal(decoded.metarCeilingStatus, ceiling === undefined ? 'none' : 'measured', source.stationname);
    assert.equal(decoded.rawMetar, raw);
    assert.equal(JSON.stringify(report), original);
  }
});

test('METAR detail grid keeps wind/visibility then ceiling/altimeter above raw text', () => {
  const properties = { metarStationId: 'KSFO', flightCategory: 'VFR' as const,
    metarWindDirection: 280, metarWindSpeedKt: 10, metarVisibilitySm: 10,
    metarCeilingStatus: 'none' as const, rawMetar: 'METAR KSFO 171800Z 28010KT 10SM CLR 20/10 A2992' };
  assert.deepEqual(metarDetailRows(properties).map(({ label, value }) => [label, value]), [
    ['Wind', '—/280°T 10 kt'], ['Visibility', '10 SM'], ['Ceiling', 'None reported'],
    ['Altimeter', '29.92 inHg'], ['Raw', properties.rawMetar],
  ]);
  assert.deepEqual(metarDetailRows({ metarStationId: 'KSFO' }).map(({ label, value }) => [label, value]), [
    ['Wind', 'Unavailable'], ['Visibility', 'Unavailable'], ['Ceiling', 'Unknown'], ['Altimeter', 'Unavailable'],
  ]);
  assert.deepEqual(metarDetailRows({}), []);
});
