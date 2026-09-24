import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MetarFeature } from '@zlayer/contracts';
import { MetarReportView } from '../src/layers/metar-taf/metar/report';
import { formatMetarWind } from '../src/layers/metar-taf/metar/format';

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
    assert.ok(html.includes(`<dt>Flight category</dt><dd>${category}</dd>`), html);
  }
});
