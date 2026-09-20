import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChartKind, ChartRecord } from '@zlayer/contracts';

import {
  availableChartBases, availableChartOverlays,
  chartCountForFamily, chartCountForSelection, chartSelectionTitle,
  chartIsSelected, NO_CHARTS,
  chartIsVisible,
  resolveChartSelection,
} from '../src/layers/charts/overlays.js';

const charts = [
  chart('sectional-sf', 'vfr-sectional'),
  chart('sectional-la', 'vfr-sectional'),
  chart('flyway-sf', 'vfr-flyway'),
  chart('ifr-l02', 'ifr-low'),
  chart('ifr-l03', 'ifr-low'),
];
const sectionalOnly = { base: 'vfr-sectional', overlay: '' } as const;
const ifrOnly = { base: 'ifr-low', overlay: '' } as const;

test('separates exclusive bases from optional overlays requiring a sectional base', () => {
  assert.deepEqual(
    availableChartBases(charts).map(base => base.id), ['vfr-sectional', 'ifr-low'],
  );
  assert.deepEqual(availableChartOverlays(charts, 'vfr-sectional').map(overlay => overlay.id), ['vfr-flyway']);
  assert.deepEqual(availableChartOverlays(charts, 'ifr-low'), []);
  assert.deepEqual(availableChartOverlays(charts, ''), []);
  assert.equal(chartCountForFamily(charts, 'vfr-sectional'), 2);
  assert.equal(chartCountForSelection(charts, NO_CHARTS), 0);
});

test('selecting a chart base activates every sheet in that family', () => {
  assert.deepEqual(
    charts.filter((candidate) => chartIsSelected(candidate.kind, ifrOnly))
      .map((candidate) => candidate.id),
    ['ifr-l02', 'ifr-l03'],
  );
  assert.equal(chartIsSelected(charts[0]!.kind, NO_CHARTS), false);
});

test('default and unavailable choices resolve safely without making overlays standalone', () => {
  assert.deepEqual(resolveChartSelection(charts, undefined, ''), sectionalOnly);
  assert.deepEqual(resolveChartSelection(charts, 'vfr-sectional', 'vfr-terminal'), sectionalOnly);
  assert.deepEqual(resolveChartSelection(charts, '', 'vfr-flyway'), NO_CHARTS);
  assert.deepEqual(resolveChartSelection([], undefined, ''), NO_CHARTS);
  assert.deepEqual(resolveChartSelection([chart('flyway', 'vfr-flyway')], undefined, 'vfr-flyway'), NO_CHARTS);
  assert.deepEqual(resolveChartSelection([chart('ifr', 'ifr-low')], 'vfr-sectional', 'vfr-flyway'), ifrOnly);
});

test('an overlay adds to sectionals but never to IFR; titles/counts reflect the whole stack', () => {
  const selection = resolveChartSelection(charts, 'vfr-sectional', 'vfr-flyway');
  assert.deepEqual(charts.filter(chart => chartIsSelected(chart.kind, selection)).map(chart => chart.id),
    ['sectional-sf', 'sectional-la', 'flyway-sf']);
  assert.equal(chartCountForSelection(charts, selection), 3);
  assert.equal(chartSelectionTitle(selection), 'VFR sectionals + VFR flyways');
  assert.deepEqual(resolveChartSelection(charts, 'ifr-low', 'vfr-flyway'), ifrOnly);
  assert.equal(chartIsSelected('vfr-flyway', { base: 'ifr-low', overlay: 'vfr-flyway' }), false,
    'the renderer enforces dependencies even for unresolved input');
});

test('only activates selected sheets intersecting the viewport', () => {
  const sectional = chart('sectional', 'vfr-sectional');
  assert.equal(chartIsVisible(sectional, sectionalOnly, [-123, 36, -121, 38]), true);
  assert.equal(chartIsVisible(sectional, ifrOnly, [-123, 36, -121, 38]), false);
  assert.equal(chartIsVisible(sectional, NO_CHARTS, [-123, 36, -121, 38]), false);
  assert.equal(chartIsVisible(sectional, sectionalOnly, [-109, 36, -107, 38]), false);
  assert.equal(chartIsVisible(sectional, sectionalOnly, [-123, 44, -121, 46]), false);
  // No low-zoom visibility cutoff when the viewport encompasses the chart.
  assert.equal(chartIsVisible(sectional, sectionalOnly, [-180, -85, 180, 85]), true);
});

test('loads both Aleutian hemispheres across the antimeridian and world copies', () => {
  const west: ChartRecord = { ...chart('west', 'vfr-sectional'), bounds: [-180, 51, -172, 54] };
  const east: ChartRecord = { ...chart('east', 'vfr-sectional'), bounds: [170, 51, 180, 54] };
  for (const bounds of [
    [175, 50, 185, 55], [175, 50, -175, 55], [-185, 50, -175, 55], [535, 50, 545, 55],
  ] as const) {
    assert.equal(chartIsVisible(west, sectionalOnly, [...bounds]), true);
    assert.equal(chartIsVisible(east, sectionalOnly, [...bounds]), true);
    assert.equal(chartIsVisible(charts[0]!, sectionalOnly, [...bounds]), false);
  }
});

test('leaving an overlay footprint keeps the sectional base visible', () => {
  const sectional = chart('sectional', 'vfr-sectional');
  const terminal: ChartRecord = { ...chart('tac', 'vfr-terminal'), bounds: [-123, 37, -122, 38] };
  const selection = resolveChartSelection([sectional, terminal], 'vfr-sectional', 'vfr-terminal');
  assert.equal(chartIsVisible(sectional, selection, [-122.8, 37.1, -122.2, 37.9]), true);
  assert.equal(chartIsVisible(terminal, selection, [-122.8, 37.1, -122.2, 37.9]), true);
  assert.equal(chartIsVisible(sectional, selection, [-121, 36, -120, 37]), true);
  assert.equal(chartIsVisible(terminal, selection, [-121, 36, -120, 37]), false);
});

function chart(id: string, kind: ChartKind): ChartRecord {
  return {
    id,
    title: id,
    kind,
    revision: '2026-09-03',
    format: 'mbtiles',
    bounds: [-125, 32, -110, 43],
    minZoom: 5,
    maxZoom: 12,
    byteLength: 1_024,
    sha256: 'a'.repeat(64),
    url: `/charts/${id}.mbtiles`,
  };
}
