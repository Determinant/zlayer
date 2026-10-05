import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { notamObstacles, notamObstacleFeatures } from '../src/layers/notams/obstacles';
import { createNotamMapPreviews } from '../src/layers/notams/map-state';
import { chartedNotamPresentation, notamChartKey } from '../src/layers/notams/chart';
import { notamBlockText, presentNotam } from '../src/layers/notams/presentation';
import { NotamList } from '../src/layers/notams/ui';
import { notice, NOTAM_NOW } from './fixtures/notams';

const text = 'OBST CRANE (ASN 2025-ASO-10959-NRA) 333831N0842606W (0.5NM NW ATL) 1209FT (200FT AGL) FLAGGED AND LGTD';

test('point obstacle coordinates and FAA MSL/AGL heights remain separate and exact', () => {
  const record = notice({ text }), before = structuredClone(record);
  const point = notamObstacles(record)[0]!;
  assert.equal(point.coordinates[0], -(84 + 26 / 60 + 6 / 3600));
  assert.equal(point.coordinates[1], 33 + 38 / 60 + 31 / 3600);
  assert.equal(point.heightAglFt, 200); assert.equal(point.elevationMslFt, 1209);
  assert.equal(point.shape, 'low', 'MSL elevation must not choose the tall AGL symbol');
  assert.equal(point.grouped, false);
  assert.equal(notamObstacleFeatures([record], NOTAM_NOW).features[0]?.properties.label, 'Crane\n1209 (200)');
  assert.deepEqual(record, before);
  for (const source of [text, `!ATL 10/001 ATL ${text}`, `TST ${text}`]) {
    assert.deepEqual(notamObstacles(notice({ text: source })), [point]);
  }
  assert.equal(notamObstacles(notice({ text: `XYZ ${text}` })).length, 0, 'unrelated identity is not stripped');
  assert.equal(notamObstacles(notice({ text: text.replace('200FT AGL', '1000FT AGL') }))[0]?.shape, 'tall');
  assert.equal(notamObstacles(notice({ text: text.replace('CRANE', 'CRANES') }))[0]?.grouped, true);
});

test('fractional seconds and southern/eastern hemispheres are decoded without rounding', () => {
  const [point] = notamObstacles(notice({ text: text.replace('333831N0842606W', '333831.50S/0842606.25E') }));
  assert.deepEqual(point?.coordinates, [84 + 26 / 60 + 6.25 / 3600, -(33 + 38 / 60 + 31.5 / 3600)]);
});

test('invalid, area, ambiguous and relative positions never become guessed point markers', () => {
  for (const source of [
    text.replace('333831N', '336031N'), text.replace('0842606W', '0842660W'), text.replace('333831N', '903831N'),
    text.replace('0842606W', '1842606W'), text.replace('333831N0842606W', 'UNKNOWN'),
    text.replace('333831N0842606W', '333831N0842606W TO 333931N0842706W'),
    text.replace('CRANE', 'WIND FARM'), text.replace('CRANE', 'CRANE WI AN AREA DEFINED AS 1NM RADIUS OF'),
    text.replace('1209FT (200FT AGL)', '1209M (200M AGL)'),
    'IAP TEST. TEMPORARY CRANE 640 MSL 4200FT EAST OF RWY 09L.',
    `DISREGARD NOTE: ${text}`, `IF AUTHORIZED: ${text}`, `${'X'.repeat(65536)} ${text}`,
  ]) assert.deepEqual(notamObstacles(notice({ text: source })), [], source.slice(0, 100));
});

test('explicit FDC point references retain all cranes and never infer AGL from MSL', () => {
  const record = notice({ text: 'IAP TEST, CA. RNAV (GPS) Y RWY 09L, AMDT 2... ' +
    'LNAV MDA 640/HAT 555 ALL CATS, VISIBILITY CATS C/D 1 1/4. ' +
    'PERM CRANE (34-000846) 439FT MSL (4A) 404104.88N/0740905.09W. ' +
    'PERM CRANE (34-083039) 242FT MSL (4D) 404123.55N/0740811.43W. 2610041159-2610051200' });
  const points = notamObstacles(record);
  assert.deepEqual(points.map(p => [p.elevationMslFt, p.heightAglFt, p.shape]), [[439, undefined, 'unknown'], [242, undefined, 'unknown']]);
  assert.notDeepEqual(points[0]!.coordinates, points[1]!.coordinates);
  assert.equal(notamObstacleFeatures([record], NOTAM_NOW).features[0]!.properties.label, 'Crane\n439 (?)');
  const readable = chartedNotamPresentation(record)!.presentation.blocks.map(notamBlockText).join(' ');
  for (const value of ['640', '555', '1 1/4', '439FT', '242FT']) assert.ok(readable.includes(value), value);
  for (const directive of ['DISREGARD NOTE:', 'CHANGE NOTE TO READ:', 'IF AUTHORIZED:', 'NOTE:']) {
    assert.deepEqual(notamObstacles({ ...record, text: record.text.replace('PERM CRANE', `${directive} PERM CRANE`) }), []);
  }
});

test('charted standalone obstacles replace the description while raw, search and timing remain available', () => {
  for (const source of [text, `!ATL 10/001 ATL ${text}`, `TST ${text}`]) {
    for (const translationOnly of [false, true]) {
      const record = notice({ text: translationOnly ? '' : source, schedule: 'DLY 1100-1300',
        translations: [{ type: 'LOCAL_FORMAT', text: source }] });
      const render = (charted?: ReadonlySet<string>) => renderToStaticMarkup(createElement(NotamList, { entries: [{ record }], now: NOTAM_NOW, charted }));
      const original = render(), mapped = render(new Set([notamChartKey(record)]));
      assert.match(original, /class="notam-readable"/);
      assert.doesNotMatch(mapped, /class="notam-readable"/);
      assert.match(mapped, /Location shown on chart/);
      assert.ok(mapped.includes(`<pre>${source}</pre>`));
      assert.match(mapped, /Schedule: DLY 1100-1300/);
      assert.match(mapped, />From<.*>Until</);
      assert.ok(presentNotam(record).searchText.includes('2025-ASO-10959-NRA'));
      assert.equal(render(new Set([record.id + ':old-revision'])), original);
    }
  }
});

test('map labels preserve timing uncertainty; cancelled and definitely expired records disappear', () => {
  const record = notice({ text });
  for (const [overrides, label] of [
    [{}, 'within interval'], [{ startsAt: NOTAM_NOW + 1000 }, 'upcoming'],
    [{ schedule: 'SR-SS' }, 'check schedule'], [{ startsAt: null }, 'check validity'],
    [{ schedule: 'DLY 1400-1800' }, 'outside schedule'],
  ] as const) {
    const features = notamObstacleFeatures([{ ...record, ...overrides }], NOTAM_NOW).features;
    assert.equal(features[0]?.properties.timing, label);
    if (label !== 'within interval') assert.match(features[0]!.properties.label.toLowerCase(), new RegExp(label));
  }
  for (const overrides of [{ lifecycle: 'cancelled' as const }, { endsAt: NOTAM_NOW - 1 }]) {
    assert.deepEqual(notamObstacleFeatures([{ ...record, ...overrides }], NOTAM_NOW).features, []);
  }
  assert.equal(notamObstacleFeatures([record, record], NOTAM_NOW).features.length, 1);
});

test('visible reader leases update independently and cannot resurrect after stow or provider reset', () => {
  const previews = createNotamMapPreviews(), first = notice({ text }), second = notice({ id: '1757600000000002', text });
  const airport = previews.open(), plate = previews.open();
  airport.update([first, second]); plate.update([first]);
  assert.equal(previews.state.getSnapshot().length, 2);
  airport.update([first]); assert.equal(previews.state.getSnapshot().length, 1, 'filtering replaces that reader’s input');
  airport.release(); assert.deepEqual(previews.state.getSnapshot(), [first], 'another open reader keeps its context');
  plate.release(); assert.deepEqual(previews.state.getSnapshot(), []);
  airport.update([second]); assert.deepEqual(previews.state.getSnapshot(), []);
  const old = previews.open(); old.update([first]); previews.clear();
  const reopened = previews.open(); reopened.update([second]); old.update([first]); old.release();
  assert.deepEqual(previews.state.getSnapshot(), [second]); reopened.release();
  assert.deepEqual(previews.state.getSnapshot(), []);
});
