import assert from 'node:assert/strict';
import test from 'node:test';
import { auditMappedNotam } from '../tools/audit-notams';
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
    const start = source.indexOf('333831N0842606W');
    assert.deepEqual(notamObstacles(notice({ text: source })), [{ ...point, coordinateSpan: { start, end: start + '333831N0842606W'.length } }]);
  }
  assert.equal(notamObstacles(notice({ text: `XYZ ${text}` })).length, 0, 'unrelated identity is not stripped');
  assert.equal(notamObstacles(notice({ text: text.replace('200FT AGL', '1000FT AGL') }))[0]?.shape, 'tall');
  assert.equal(notamObstacles(notice({ text: text.replace('CRANE', 'CRANES') }))[0]?.grouped, true);
});

test('unassembled multipart and instruction scope cannot publish procedure obstacles', () => {
  const crane = 'PERM CRANE (2015-AWP-1234-OE) 500FT MSL 370000N1220000W.';
  for (const control of ['PART 1 OF 2.', 'DELETE NOTE:', 'EXCEPT WHEN AUTHORIZED.', 'MISSED APPROACH:']) {
    const record = notice({ text: `IAP TEST, CA. ILS RWY 09, AMDT 1... ${control} ${crane}` });
    assert.deepEqual(notamObstacles(record), [], control);
    assert.equal(chartedNotamPresentation(record), undefined);
  }
  const complete = notice({ text: `PART 1 OF 2 IAP TEST. ${crane} END PART 1 OF 2 PART 2 OF 2 ${crane.replace('370000N', '371000N')} END PART 2 OF 2` });
  assert.equal(notamObstacles(complete).length, 2);
  assert.deepEqual(chartedNotamPresentation(complete)!.presentation, presentNotam(complete), 'complete transport keeps its original source qualifications');
});

test('mapped obstacle elision removes only its source occurrence and the audit catches quoted-coordinate loss', () => {
  const coordinate = '370000N1220000W';
  const source = `IAP TEST, CA. ILS RWY 09, AMDT 1... PERM CRANE (2015-AWP-1234-OE) 500FT MSL ${coordinate}. DELETE NOTE: AVOID OVERFLIGHT OF ${coordinate}.`;
  for (const text of [source, '!FDC 6/1234 TST ' + source, source.replaceAll('. ', '.\n\n'), source.toLowerCase()]) {
    const record = notice({ text, translations: [] }), points = notamObstacles(record);
    assert.equal(points.length, 1);
    assert.deepEqual(points[0]!.coordinateSpan, { start: text.toUpperCase().indexOf(coordinate), end: text.toUpperCase().indexOf(coordinate) + coordinate.length });
    const reading = chartedNotamPresentation(record)!.presentation;
    assert.equal(reading.searchText.match(new RegExp(coordinate, 'gi'))?.length, 1);
    assert.deepEqual(auditMappedNotam(record), []);
    const damaged = presentNotam({ ...record, text: text.replace(new RegExp(coordinate, 'gi'), '') });
    assert.deepEqual(auditMappedNotam(record, damaged), ['mapped operational content differs']);
  }
  const record = notice({ text: `IAP TEST. PERM CRANE (${coordinate}) 500FT MSL ${coordinate}.` });
  assert.equal(notamObstacles(record)[0]!.coordinateSpan.start, record.text.lastIndexOf(coordinate), 'capture offsets must not find the identical token in a different field');
  assert.match(chartedNotamPresentation(record)!.presentation.searchText, new RegExp(`\\(${coordinate}\\)`));
});

test('fractional seconds and southern/eastern hemispheres are decoded without rounding', () => {
  const [point] = notamObstacles(notice({ text: text.replace('333831N0842606W', '333831.50S/0842606.25E') }));
  assert.deepEqual(point?.coordinates, [84 + 26 / 60 + 6.25 / 3600, -(33 + 38 / 60 + 31.5 / 3600)]);
});

test('ARTCC obstacle types and explicitly unknown heights retain exact positions without inventing elevations', () => {
  for (const kind of ['WATER TOWER', 'POWER TWR', 'TRANSMISSION TOWER', 'POWER LINE', 'DEEP SPACE ANTENNA']) {
    const record = notice({ text: text.replace('CRANE', kind).replace('1209FT', 'UNKNOWN') });
    const [point] = notamObstacles(record);
    assert.ok(point); assert.equal(point.elevationMslFt, undefined); assert.equal(point.heightAglFt, 200);
    assert.equal(point.shape, 'low');
    assert.match(notamObstacleFeatures([record], NOTAM_NOW).features[0]!.properties.label, /\? \(200\)/);
    assert.match(chartedNotamPresentation(record)!.presentation.searchText, /FLAGGED AND LGTD/i);
  }
  for (const source of [text.replace('1209FT', '1209'), text.replace('200FT AGL', '200FT')]) {
    const record = notice({ text: source }), point = notamObstacles(record)[0]!;
    assert.ok(point);
    const reading = chartedNotamPresentation(record)!.presentation.searchText;
    assert.match(reading, /1209/); assert.match(reading, /200FT/); assert.match(reading, /FLAGGED AND LGTD/i);
  }
});

test('minute-only point coordinates use the same accepted location receipt without claiming a repair', () => {
  const record = notice({ text: 'OBST CRANE 3700N12200W 350FT (200FT AGL) FLAGGED' });
  assert.deepEqual(notamObstacles(record)[0]!.coordinates, [-122, 37]);
  assert.equal(chartedNotamPresentation(record)!.note, 'Location shown on chart');
  assert.match(chartedNotamPresentation(record)!.presentation.searchText, /FLAGGED/i);
  assert.deepEqual(auditMappedNotam(record), []);
});

test('airport obstacle field variants preserve position, height datums and lighting status', () => {
  const coordinate = '333831N0842606W';
  for (const kind of ['SILO', 'WATERTOWER', 'SHIP MAST', 'OIL RIG', 'PARKED ACFT', 'DIRT STOCKPILE', 'COOLING TOWER', 'TOWER LINE', 'LGT']) {
    for (const annotation of ['(.9NM S OF APCH END OF RWY 09L)', '(25.4NMNW MOB SPA)', '(.4NM MEB)', '(500FT E RWY 16/34)', '(ENA199003)']) {
      const record = notice({ text: `OBST ${kind} (ASR-#UNKNOWN) ${coordinate} ${annotation} 1209FT (200FT AGL) U/S` });
      const [point] = notamObstacles(record);
      assert.ok(point, record.text);
      assert.deepEqual(point.coordinates, [-84 - 26 / 60 - 6 / 3600, 33 + 38 / 60 + 31 / 3600]);
      assert.equal(point.elevationMslFt, 1209); assert.equal(point.heightAglFt, 200);
      const reading = chartedNotamPresentation(record)!.presentation.searchText;
      assert.match(reading, /U\/S/);
      if (kind === 'LGT') assert.match(reading, /LGT/);
      assert.deepEqual(auditMappedNotam(record), []);
    }
  }
  for (const [heights, msl, agl] of [['779FT', 779, undefined], ['40FT AGL', undefined, 40], ['(150FT AGL)', undefined, 150]] as const) {
    const record = notice({ text: `OBST CRANE ${coordinate} ${heights} NOT LGTD` }), [point] = notamObstacles(record);
    assert.ok(point); assert.equal(point.elevationMslFt, msl); assert.equal(point.heightAglFt, agl);
    assert.deepEqual(chartedNotamPresentation(record)!.presentation, presentNotam(record), 'incomplete heights retain the complete source');
  }
  for (const prefix of ['TOWER LGT (ASN 2024-AGL-1234-O', 'AIRSPACE CRANE', 'OBSTACLE POLE']) {
    const record = notice({ text: `${prefix} ${coordinate} 1209FT (200FT AGL) U/S` });
    assert.equal(notamObstacles(record).length, 1, prefix);
    assert.deepEqual(chartedNotamPresentation(record)!.presentation, presentNotam(record));
  }
  for (const prefix of ['OBST CRANE (UNKNOWN POSITION)', 'OBST CRANE']) {
    const record = notice({ text: `${prefix} (500FT E RWY 16/34) 1209FT (200FT AGL) U/S` });
    assert.deepEqual(notamObstacles(record), [], 'annotations and identifiers alone cannot supply a position');
  }
});

test('explicit FAS and ramp positions preserve unqualified numbers and shared instruction scope', () => {
  const examples = [
    'IAP TEST. RNAV RWY 09, ORIG... FAS OBST: 3136 TOWER (12-0345) 370000N1220000W.',
    'ALL ALL ADC RAMP - OBSTRUCTION LIGHT OUTAGE ON RAMP LOCATED AT 370000N1220000W',
  ];
  for (const text of examples) {
    const record = notice({ text }), point = notamObstacles(record)[0]!;
    assert.ok(point); assert.deepEqual(point.coordinates, [-122, 37]);
    assert.equal(point.heightAglFt, undefined); assert.equal(point.elevationMslFt, undefined);
    assert.equal(point.shape, 'unknown');
    assert.deepEqual(chartedNotamPresentation(record)!.presentation, presentNotam(record));
    const repaired = notice({ text: text.replace('370000N', '365960N') });
    assert.equal(notamObstacles(repaired)[0]!.recovered, true);
    assert.match(notamObstacleFeatures([repaired], NOTAM_NOW).features[0]!.properties.label, /Recovered coordinate/);
    for (const control of ['DELETE NOTE:', 'IF AUTHORIZED:', 'PART 1 OF 2']) {
      assert.deepEqual(notamObstacles(notice({ text: `${control} ${text}` })), []);
    }
  }
});

test('invalid, area, ambiguous and relative positions never become guessed point markers', () => {
  for (const source of [
    text.replace('333831N', '336031N'), text.replace('0842606W', '0842661W'), text.replace('333831N', '903831N'),
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
      assert.match(original, /class="(?:[^"]*\s)?notam-readable(?:\s[^"]*)?"/);
      assert.match(mapped, /class="(?:[^"]*\s)?notam-readable(?:\s[^"]*)?"/);
      assert.match(mapped, /Flagged and LGTD/);
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
  airport.update([first, second]);
  const shared = previews.state.getSnapshot(), otherAirportRegion = previews.open();
  otherAirportRegion.update([first, second]); plate.update([first]);
  assert.equal(previews.state.getSnapshot(), shared, 'another reader of the same region does not republish map input');
  otherAirportRegion.release();
  assert.equal(previews.state.getSnapshot(), shared, 'releasing a duplicate reader leaves the existing depiction intact');
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

test('highlight leases follow accepted revisions and cannot clear another reader’s interaction', () => {
  const previews = createNotamMapPreviews(), first = notice({ text }), second = notice({ id: '1757600000000002', text });
  const airport = previews.open(), region = previews.open();
  airport.update([first]); region.update([second]);
  const firstKey = notamChartKey(first), secondKey = notamChartKey(second);
  const leaveAirport = airport.highlight(firstKey);
  assert.equal(previews.highlighted.getSnapshot(), undefined, 'pending geometry cannot be highlighted');
  previews.show([firstKey, secondKey]);
  assert.equal(previews.highlighted.getSnapshot(), firstKey);
  const leaveRegion = region.highlight(secondKey);
  leaveAirport(); assert.equal(previews.highlighted.getSnapshot(), secondKey);
  region.update([]); assert.equal(previews.highlighted.getSnapshot(), undefined);
  region.update([second]); assert.equal(previews.highlighted.getSnapshot(), undefined, 'filter removal releases the previous highlight');
  region.highlight(secondKey); previews.show([]);
  assert.equal(previews.highlighted.getSnapshot(), undefined, 'map failure/detachment clears emphasis');
  previews.clear(); region.update([second]); region.highlight(secondKey); leaveRegion(); previews.show([secondKey]);
  assert.equal(previews.highlighted.getSnapshot(), undefined, 'a released owner cannot resurrect emphasis');
});
