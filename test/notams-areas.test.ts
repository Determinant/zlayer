import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { distanceNm } from '@zlayer/domain';
import { notamArea } from '../src/layers/notams/areas';
import { chartedNotamPresentation, notamChartFeatures, notamChartKey } from '../src/layers/notams/chart';
import { NotamList } from '../src/layers/notams/ui';
import { notamBlockText, presentNotam } from '../src/layers/notams/presentation';
import { notice, NOTAM_NOW } from './fixtures/notams';

const circle = 'AIRSPACE UAS WI AN AREA DEFINED AS 3.2NM RADIUS OF 325151.50N0970622W (4.0NM WSW DFW) SFC-400FT AGL';
const polygon = 'AIRSPACE UAS WI AN AREA DEFINED AS 373735N1222415W (1.4NM W SFO) TO 373736N1222410W (1.4NM W SFO) ' +
  'TO 373651N1222354W (1.1NM WSW SFO) TO 373648N1222358W (1.2NM WSW SFO) TO 373719N1222422W (1.5NM W SFO) ' +
  'TO 373724N1222413W (1.4NM W SFO) TO POINT OF ORIGIN SFC-25FT AGL';
// FAA AIM GPS-testing example; retains the stated altitude-dependent footprint.
const gps = 'NAV GPS (INCLUDING WAAS, GBAS, AND ADS-B) MAY NOT BE AVAILABLE WITHIN A 468NM RADIUS CENTERED AT ' +
  '330702N1062540W (TCS 093044) FL400-UNL DECREASING IN AREA WITH A DECREASE IN ALTITUDE DEFINED AS: ' +
  '425NM RADIUS AT FL250, 360NM RADIUS AT 10000FT, 354NM RADIUS AT 4000FT AGL, 327NM RADIUS AT 50FT AGL.';

test('published circle radius and DMS center generate bounded geodesic geometry', () => {
  const record = notice({ text: circle }), before = structuredClone(record), area = notamArea(record)!;
  assert.deepEqual(area.labelPosition, [-(97 + 6 / 60 + 22 / 3600), 32 + 51 / 60 + 51.5 / 3600]);
  assert.equal(area.label, 'UAS\nSFC-400FT AGL'); assert.equal(area.outer, false);
  assert.deepEqual(area.ring[0], area.ring.at(-1));
  assert.ok(area.ring.length >= 65 && area.ring.length <= 721);
  for (const vertex of area.ring) assert.ok(Math.abs(distanceNm(area.labelPosition, vertex) - 3.2) < 1e-8);
  assert.equal(circle.slice(area.span.start, area.span.end), 'WI AN AREA DEFINED AS 3.2NM RADIUS OF 325151.50N0970622W (4.0NM WSW DFW)');
  assert.deepEqual(record, before);
  assert.ok(notamArea(notice({ text: circle.replace('3.2NM RADIUS OF', '.1NM RADIUS').replace('325151.50N0970622W', '325151.50S0970622E') })));
});

test('published closed polygon keeps its vertices and wraps across the dateline locally', () => {
  const area = notamArea(notice({ text: polygon }))!;
  assert.equal(area.label, 'UAS\nSFC-25FT AGL'); assert.equal(area.ring.length, 7);
  assert.ok(area.ring.some(([lon, lat]) => Math.abs(lon + 122 + 24 / 60 + 15 / 3600) < 1e-9 && Math.abs(lat - 37 - 37 / 60 - 35 / 3600) < 1e-9));
  const wrapped = notamArea(notice({ text: 'AIRSPACE UAS WI AN AREA DEFINED AS 100000N1795000E TO 100000N1795000W TO 110000N1795000W TO 110000N1795000E TO POINT OF ORIGIN SFC-400FT AGL' }))!;
  assert.ok(Math.max(...wrapped.ring.map(p => p[0])) - Math.min(...wrapped.ring.map(p => p[0])) < 1);
  assert.deepEqual(wrapped.ring[0], wrapped.ring.at(-1));
});

test('GPS outer footprint is qualified and all altitude tiers survive the shorter reader', () => {
  const record = notice({ text: gps }), area = notamArea(record)!;
  assert.equal(area.label, 'GPS may be unavailable\nOuter extent\nFL400-UNL'); assert.equal(area.outer, true);
  for (const vertex of area.ring) assert.ok(Math.abs(distanceNm(area.labelPosition, vertex) - 468) < 1e-7);
  const shortened = chartedNotamPresentation(record)!;
  assert.match(shortened.note, /Outer area.*varies with altitude/);
  const text = shortened.presentation.blocks.map(notamBlockText).join(' ');
  for (const value of ['FL400-UNL', '425NM', 'FL250', '360NM', '10000FT', '354NM', '4000FT AGL', '327NM', '50FT AGL']) assert.ok(text.includes(value), value);
  assert.match(text, /may not be available/i); assert.doesNotMatch(text, /330702N1062540W/);
});

test('ambiguous, malformed, partial, quoted and unsupported boundaries remain full text', () => {
  for (const text of [circle.replace('NM RADIUS OF', 'SM RADIUS OF'), circle.replace('3.2NM', '0NM'), circle.replace('3.2NM', '1000NM'),
    circle.replace('325151.50N', '326051.50N'), circle.replace('0970622W', '1810622W'), circle.replace('325151.50N0970622W', 'DFW'),
    circle.replace('4.0NM WSW DFW', 'EXC RWY 18'), circle + ' EXCLUDING AIRSPACE EAST OF RWY 18',
    circle + ' AND WI AN AREA DEFINED AS 1NM RADIUS OF 330000N0970000W SFC-300FT AGL',
    'DISREGARD NOTE: ' + circle, circle.replace('UAS WI', 'UAS NOTE: WI'),
    polygon.replace(' TO POINT OF ORIGIN', ''), polygon.replace('ORIGIN', 'ORGIN'),
    'AIRSPACE UAS WI AN AREA DEFINED AS .5NM EITHER SIDE OF A LINE FM 370000N1220000W TO 380000N1230000W SFC-400FT AGL',
    'AIRSPACE UAS WI AN AREA DEFINED AS 370000N1220000W TO 380000N1230000W TO 370000N1230000W TO 380000N1220000W TO POINT OF ORIGIN SFC-400FT AGL',
    gps + ' EXCLUDING AIRSPACE OVER THE AIRPORT', circle + 'X'.repeat(65536),
  ]) {
    const record = notice({ text });
    assert.equal(notamArea(record), undefined, text.slice(0, 160));
    assert.equal(chartedNotamPresentation(record), undefined, text.slice(0, 160));
  }
});

test('geometry receipt controls shortened text; raw, search, altitude and schedule stay complete', () => {
  const text = circle + ' DLY 1100-0300', record = notice({ text, schedule: 'DLY 1100-0300', translations: [] });
  const render = (charted?: ReadonlySet<string>) => renderToStaticMarkup(createElement(NotamList, { entries: [{ record }], now: NOTAM_NOW, charted }));
  const original = render(), mapped = render(new Set([notamChartKey(record)]));
  assert.ok(original.includes('325151.50N0970622W')); assert.ok(!original.includes('shown on chart'));
  assert.doesNotMatch(mapped.slice(0, mapped.indexOf('<details')).replace(/<[^>]*>/g, ''), /325151.50N0970622W/);
  assert.match(mapped, /Area shown on chart/); assert.match(mapped, /SFC-400FT AGL/); assert.match(mapped, /DLY 1100-0300/);
  assert.ok(mapped.includes(`<pre>${text}</pre>`));
  assert.ok(presentNotam(record).searchText.includes('325151.50N0970622W'));
  assert.equal(render(new Set([record.id + ':old-revision'])), original);
  assert.equal(notamChartFeatures([{ ...record, lifecycle: 'cancelled' }], NOTAM_NOW).features.length, 0);
  assert.equal(notamChartFeatures([{ ...record, endsAt: NOTAM_NOW - 1 }], NOTAM_NOW).features.length, 0);
  const upcoming = notamChartFeatures([{ ...record, startsAt: NOTAM_NOW + 1000 }], NOTAM_NOW);
  assert.equal(upcoming.features.length, 2); assert.match(upcoming.features[0]!.properties.label, /Upcoming/);
});
