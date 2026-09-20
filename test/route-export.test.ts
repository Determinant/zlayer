import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteResolver, emptyRoutePlan } from '@zlayer/domain';
import type { FeatureCollectionResponse, PreferredRoutesData } from '@zlayer/contracts';
import { foreFlightRouteUrl, routeExportText } from '../src/layers/routes/export';

test('ForeFlight handoff automatically converts coordinates and safely encodes the route', () => {
  const text = 'KSFO UNKNOWN 374500N1223000W KSJC';
  const plan = emptyRoutePlan(text);
  const url = new URL(foreFlightRouteUrl(plan));
  assert.equal(url.protocol, 'foreflightmobile:');
  assert.equal(url.hostname, 'maps');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), 'KSFO UNKNOWN 374500N/1223000W KSJC');
  assert.ok(url.href.includes('374500N%2F1223000W'));
  assert.equal(routeExportText(plan), text);
});

test('target coordinate formats preserve route items and leave the saved route precision unchanged', () => {
  const text = 'KSFO 374529N1223030W V25 UNKNOWN 123456S0095959E KSJC';
  const plan = emptyRoutePlan(text);
  assert.equal(routeExportText(plan, 'skyvector'), text);
  assert.equal(routeExportText(plan, 'foreflight'), 'KSFO 374529N/1223030W V25 UNKNOWN 123456S/0095959E KSJC');
  assert.equal(routeExportText(plan, 'icao'), 'KSFO 3745N12231W V25 UNKNOWN 1235S01000E KSJC');
  assert.equal(routeExportText(plan), text);
  assert.equal(plan.entries.map(entry => entry.text).join(' '), text);
});

test('whole-minute export handles half-minute ties, degree carry, poles, dateline and leading zeros', () => {
  for (const [input, expected] of [
    ['005929N0005929E', '0059N00059E'],
    ['005930S0005930W', '0100S00100W'],
    ['895959N1795959E', '9000N18000E'],
    ['900000S1800000W', '9000S18000W'],
    ['000000N0000000E', '0000N00000E'],
  ]) assert.equal(routeExportText(emptyRoutePlan(input), 'icao'), expected);
  for (const format of ['foreflight', 'skyvector', 'icao'] as const) {
    assert.equal(routeExportText(emptyRoutePlan(), format), '');
    assert.equal(routeExportText(emptyRoutePlan('376000N1220000W'), format), '376000N1220000W', 'invalid entries stay visible');
  }
});

test('export expands TEC shorthand without duplicating published endpoints or changing the draft', () => {
  const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
    meta: { layer: 'airports', revision: 'test', returned: 2, truncated: false },
    features: ['SNA', 'BUR'].map((ident, index) => ({ type: 'Feature', id: ident,
      properties: { faaId: ident, icaoId: `K${ident}` }, geometry: { type: 'Point', coordinates: [-118, 33 + index] } })),
  };
  const preferred: PreferredRoutesData = { type: 'ZLayerPreferredRoutes',
    metadata: { effectiveDate: '2026-09-03', source: 'test' }, routes: [{
      id: 'tec', originId: 'SNA', destinationId: 'BUR', routeType: 'TEC', routeNumber: 1,
      designator: 'CSTQ1', route: 'SNA SLI V23 POPPR BUR', segments: [],
    }] };
  const plan = createRouteResolver([airports], undefined, undefined, preferred)('KSNA CSTQ1 KBUR UNKNOWN');
  assert.equal(plan.tecRoutes.length, 1);
  assert.equal(routeExportText(plan), 'KSNA SLI V23 POPPR KBUR UNKNOWN');
  assert.deepEqual(plan.entries.map(entry => entry.text), ['KSNA', 'CSTQ1', 'KBUR', 'UNKNOWN']);
  for (const format of ['foreflight', 'skyvector', 'icao'] as const) {
    assert.equal(routeExportText(plan, format), 'KSNA SLI V23 POPPR KBUR UNKNOWN');
  }
});
