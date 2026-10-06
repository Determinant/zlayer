import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isNotamRegionSnapshot, isFeatureCollectionResponse, type NavigationData } from '@zlayer/contracts';
import navaids from './fixtures/notams-us-artcc/zny-navaids.json';
import { notamRadials, notamRadialDirections } from '../src/layers/notams/radials';
import { createNotamAreaReferences } from '../src/layers/notams/area-references';
import { chartedNotamPresentation, notamChartFeatures } from '../src/layers/notams/chart';
import { notice, NOTAM_NOW } from './fixtures/notams';

const collection: unknown = navaids;
assert(isFeatureCollectionResponse(collection));
const navigation: NavigationData = { navaids: collection };
const references = createNotamAreaReferences(navigation);

test('every captured KEWR ARTCC radial notice resolves its affected stations using published alignment', () => {
  const snapshots: unknown[] = gunzipSync(readFileSync(new URL('./fixtures/notams-us-artcc/snapshots.jsonl.gz', import.meta.url)))
    .toString().trim().split('\n').map(line => JSON.parse(line));
  const snapshot = snapshots.find(value => isNotamRegionSnapshot(value) && value.query.artccId === 'ZNY');
  assert(isNotamRegionSnapshot(snapshot));
  const records = snapshot.records.filter(r => /\bR-\d{3}\b/.test(r.text));
  assert.equal(records.length, 26);
  let count = 0;
  for (const record of records) {
    const parsed = notamRadials(record), directions = notamRadialDirections(record, references);
    assert.ok(parsed.length, record.id); count += parsed.length;
    assert.equal(directions.length, parsed.length, record.id);
    for (const direction of directions) {
      const station = navaids.features.find(f => f.properties.ident === direction.ident)!;
      assert.ok(direction.coordinates.every((value, i) => Math.abs(value - station.geometry.coordinates[i]!) < 1e-10));
      assert.ok(Math.abs(direction.bearing - (direction.radial + station.properties.stationDeclinationDeg + 360) % 360) < 1e-8);
    }
    assert.ok(notamChartFeatures([record], record.startsAt!, references).features.some(f => f.properties.kind === 'radial'));
    assert.match(chartedNotamPresentation(record)!.note, /directions.*distances and altitudes/);
  }
  assert.equal(count, 30);
});

test('radial lists share one station label, retain source qualifications and never invent a geographic extent', () => {
  const record = notice({ text: 'ROUTE ZNY. CCC VOR R-274 AND R-057 UNUSABLE BEYOND 40 NM BELOW 6500. USE BAL VOR R-334.' });
  assert.deepEqual(notamRadials(record), [{ ident: 'CCC', radial: 274 }, { ident: 'CCC', radial: 57 }]);
  const features = notamChartFeatures([record], NOTAM_NOW, references).features;
  assert.deepEqual(features.map(f => f.geometry.type), ['Point', 'Point', 'Point']);
  const labels = features.filter(f => f.properties.kind === 'radial-label');
  assert.equal(labels.length, 1); assert.match(labels[0]!.properties.label, /CCC R-274 \/ R-057\nDirection only/);
  assert.match(chartedNotamPresentation(record)!.presentation.searchText, /BEYOND 40 NM BELOW 6500/i);
  assert.deepEqual(notamChartFeatures([record, { ...record, id: 'duplicate' }], NOTAM_NOW, references).features
    .map(f => f.properties.noticeIds), features.map(() => [record.id, 'duplicate']));
  for (const changed of [{ ...record, lifecycle: 'cancelled' as const }, { ...record, endsAt: NOTAM_NOW - 1 }]) {
    assert.equal(notamChartFeatures([changed], NOTAM_NOW, references).features.length, 0);
  }
});

test('missing or ambiguous station alignment, sectors, malformed bearings and restricted-area IDs are not radial directions', () => {
  for (const text of ['AIRSPACE R-5206 ACT SFC-10000FT', 'HTO VOR R-236 TO MANTA INT',
    'HTO VOR R-999 UNUSABLE', 'HTO VOR R-O75 UNUSABLE', 'HTO VOR R-114 CW R-124 RESTRICTED',
    'HTO VOR R-114-R-124 RESTRICTED', 'HTO VOR R-114 AND R-999 UNUSABLE']) assert.deepEqual(notamRadials(notice({ text })), []);
  const record = notice({ text: 'HTO VOR R-236 UNUSABLE BEYOND 52 NM' });
  assert.deepEqual(notamRadialDirections(record), []);
  for (const features of [[], [...navigation.navaids!.features, ...navigation.navaids!.features],
    navigation.navaids!.features.map(f => { const properties = { ...f.properties }; delete properties.stationDeclinationDeg;
      return { ...f, properties }; })]) {
    const resolve = createNotamAreaReferences({ navaids: { ...navigation.navaids!, features } });
    assert.deepEqual(notamChartFeatures([record], NOTAM_NOW, resolve).features, []);
  }
});

test('radial references respect sticky instruction scope and multipart proof', () => {
  for (const text of [
    'ROUTE ZNY. DELETE NOTE: HTO VOR R-236 UNUSABLE.',
    'CHANGE NOTE: HTO VOR R-236 UNUSABLE TO READ HTO VOR R-240 UNUSABLE.',
    'IF AUTHORIZED. DELETE NOTE: HTO VOR R-236 UNUSABLE.',
    'PART 1 OF 2 ROUTE ZNY. HTO VOR R-236 UNUSABLE. END PART 1 OF 2',
    'ROUTE ZNY. PART 1 OF 10. HTO VOR R-236 UNUSABLE.',
  ]) assert.deepEqual(notamRadials(notice({ text })), [], text);
  assert.deepEqual(notamRadials(notice({ text: 'HTO VOR R-236 UNUSABLE. DELETE NOTE: HTO VOR R-240 UNUSABLE.' })),
    [{ ident: 'HTO', radial: 236 }]);
});
