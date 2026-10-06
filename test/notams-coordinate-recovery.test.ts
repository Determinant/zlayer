import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinateToken, resolveCoordinate } from '../src/layers/notams/coordinate-recovery';
import { notamArea } from '../src/layers/notams/areas';
import { notamObstacles } from '../src/layers/notams/obstacles';
import { notamActivityPoint } from '../src/layers/notams/activity-points';
import { notamChartFeatures, chartedNotamPresentation } from '../src/layers/notams/chart';
import { notice, NOTAM_NOW } from './fixtures/notams';
import { auditMappedNotam } from '../tools/audit-notams';

test('exact second carries and displaced hemisphere letters preserve fields and retain source qualifications', () => {
  for (const [raw, expected] of [['342460N1293000W', [-129.5, 34 + 25 / 60]],
    ['370000N07240W00', [-72 - 40 / 60, 37]], ['895960S1795960E', [180, -90]]] as const) {
    const token = coordinateToken(raw)!;
    assert.deepEqual(token.location, expected); assert.equal(token.recovered, true);
  }
  const record = notice({ text: 'AIRSPACE UAS WI AN AREA DEFINED AS 2NM RADIUS OF 342460N1293000W SFC-FL200' });
  const area = notamArea(record)!;
  assert.match(area.label, /Recovered coordinate/); assert.match(area.label, /SFC-FL200/);
  assert.ok(chartedNotamPresentation(record)!.presentation.searchText.includes('342460N1293000W'));
  assert.deepEqual(auditMappedNotam(record), []);
  for (const bad of ['346000N1293000W', '346160N1293000W', '342461N1293000W', '906000N1293000W', '342459N1800060W', '4030119N08015737W', '34424250.39N0870802.40W']) assert.equal(coordinateToken(bad), undefined, bad);
});

test('hemisphere repairs require an independent unique published reference in either hemisphere', () => {
  const record = notice(), token = coordinateToken('305053N0991613 (7.2NM NW T92)')!;
  assert.ok(!Array.isArray(token.location));
  assert.equal(resolveCoordinate(token.location, record), undefined);
  const correct = () => [-99.18400597, 30.73219302] as [number, number];
  const wrong = () => [10, 30] as [number, number];
  assert.deepEqual(resolveCoordinate(token.location, record, correct), [-99 - 16 / 60 - 13 / 3600, 30 + 50 / 60 + 53 / 3600]);
  assert.equal(resolveCoordinate(token.location, record, wrong), undefined);
  const east = coordinateToken('130000N1444500 (6NM E GUM)')!;
  assert.ok(!Array.isArray(east.location));
  assert.deepEqual(resolveCoordinate(east.location, record, () => [144.65, 13]), [144.75, 13]);
  const text = 'OBST TOWER LGT 344744.03M0845850.02W (6NM NW DNN) UNKNOWN (300FT AGL) U/S';
  const obstacle = notice({ text });
  assert.equal(notamObstacles(obstacle).length, 0);
  const refs = () => [-84.87024138, 34.72293888] as [number, number];
  const point = notamObstacles(obstacle, refs)[0]!;
  assert.equal(point.recovered, true); assert.ok(point.coordinates[1] > 0);
  assert.equal(notamChartFeatures([obstacle], NOTAM_NOW, refs).features.length, 1);
  assert.equal(notamChartFeatures([obstacle], NOTAM_NOW, wrong).features.length, 0, 'reference replacement cannot reuse a recovery');
  assert.equal(notamObstacles(notice({ text: text.replace('NW DNN', 'SE DNN') }), refs).length, 0);
});

test('short longitude cannot silently relocate a US tower into the eastern Atlantic', () => {
  assert.equal(coordinateToken('333528N113242W (44NM WSW E25)'), undefined);
  assert.deepEqual(coordinateToken('363757N971058W')?.location, [-97 - 10 / 60 - 58 / 3600, 36 + 37 / 60 + 57 / 3600]);
  assert.equal(coordinateToken('370958N11920545W') , undefined, 'extra digits without corroboration remain unresolved');
  const token = coordinateToken('370958N11920545W (34NM NE FAT)')!;
  assert.ok(!Array.isArray(token.location));
  assert.equal(resolveCoordinate(token.location, notice(), () => [-119.71883333, 36.77655555]), undefined, 'missing-decimal interpretation conflicts with the stated distance');
});

test('laser and moving balloon positions use points, retain prose and never invent a footprint', () => {
  for (const text of ['TN..AIRSPACE CLINTON, TN..LASER LGT DEMONSTRATION WI AN AREA DEFINED AS 360506.3N0840739.2W (VXV317015.7) SFC-1300FT. LASER LGT BEAMS MAY BE INJURIOUS WI 1300FT LATERALLY.',
    'AIRSPACE UNMANNED FREE BALLOON 400608N1040742W (20NM SW FMM) SFC-FL950 SEB']) {
    const record = notice({ text });
    assert.ok(notamActivityPoint(record));
    const features = notamChartFeatures([record], NOTAM_NOW).features;
    assert.equal(features.length, 1); assert.equal(features[0]!.geometry.type, 'Point');
    assert.ok(chartedNotamPresentation(record)!.presentation.searchText.includes(text.includes('LASER') ? '1300FT' : 'SEB'));
    assert.deepEqual(auditMappedNotam(record), []);
  }
});
