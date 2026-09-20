import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MetarFeature } from '@zlayer/contracts';
import { MetarReportView } from '../src/layers/metar-taf/metar/report';

const now = Date.parse('2026-09-17T18:00:00Z');

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
