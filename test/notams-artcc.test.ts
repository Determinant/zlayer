import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { isGeoPointFeature, isNotamRegionSnapshot, isTfrSnapshot, type NavigationData, type NotamRecord } from '@zlayer/contracts';
import { distanceNm } from '@zlayer/domain';
import { notamArea, notamAreaDefinition } from '../src/layers/notams/areas';
import { createNotamAreaReferences } from '../src/layers/notams/area-references';
import { presentNotam } from '../src/layers/notams/presentation';
import { notamChartFeatures, chartedNotamPresentation } from '../src/layers/notams/chart';
import { tfrFeatures } from '../src/layers/notams/tfr-map';
import { chartedTfrReference } from '../src/layers/notams/tfr-reference';
import { notamActivityPoint } from '../src/layers/notams/activity-points';
import { notamObstacles } from '../src/layers/notams/obstacles';
import { localNotamContent, parseNotam } from '../src/layers/notams/parser';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotamList } from '../src/layers/notams/ui';
import { auditNotam, auditMappedNotam, auditRenderedNotam } from '../tools/audit-notams';
import manifest from './fixtures/notams-us-artcc/manifest.json' with { type: 'json' };
import unsupported from './fixtures/notams-us-artcc/unsupported.json' with { type: 'json' };
import widerReview from './fixtures/notams-us-artcc/wider-review.json' with { type: 'json' };
import obstacles from './fixtures/notams-us-artcc/obstacles.json' with { type: 'json' };

function readPinned(metadata: { file: string; bytes: number; sha256: string }) {
  const file = readFileSync(new URL(`./fixtures/notams-us-artcc/${metadata.file}`, import.meta.url));
  const bytes = metadata.file.endsWith('.gz') ? gunzipSync(file, { maxOutputLength: metadata.bytes }) : file;
  assert.equal(bytes.length, metadata.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
  return bytes.toString('utf8');
}
const lines = readPinned(manifest.payload).trimEnd().split('\n');
const source = JSON.parse(readPinned(manifest.areaReferences));
const data: NavigationData = {};
for (const id of ['airports', 'navaids'] as const) {
  assert.equal(source[id].length, manifest.areaReferences[id]);
  assert.ok(source[id].every(isGeoPointFeature));
  data[id] = { type: 'FeatureCollection', features: source[id], meta: {
    layer: id, revision: manifest.areaReferences.effectiveDate, returned: source[id].length, truncated: false } };
}
const references = createNotamAreaReferences(data);

test('every US ARTCC and published FIR scope preserves all source/readers and accounts for geometry', t => {
  assert.deepEqual(manifest.regions.filter(r => 'artccId' in r).map(r => r.artccId), [
    'ZAB', 'ZAK', 'ZAN', 'ZAP', 'ZAU', 'ZBW', 'ZDC', 'ZDV', 'ZFW', 'ZHN', 'ZHU', 'ZID', 'ZJX',
    'ZKC', 'ZLA', 'ZLC', 'ZMA', 'ZME', 'ZMP', 'ZNY', 'ZOA', 'ZOB', 'ZSE', 'ZSU', 'ZTL', 'ZUA', 'ZWY',
  ]);
  assert.deepEqual(manifest.regions.filter(r => 'firId' in r).map(r => r.firId), [
    'KZAB', 'KZAK', 'KZAU', 'KZBW', 'KZDC', 'KZDV', 'KZFW', 'KZHU', 'KZID', 'KZJX', 'KZKC', 'KZLA', 'KZLC',
    'KZMA', 'KZME', 'KZMP', 'KZNY', 'KZOA', 'KZOB', 'KZSE', 'KZTL', 'KZWY', 'PAZA', 'PAZN', 'PGZU', 'PHZH', 'TJZS',
  ]);
  assert.equal(lines.length, manifest.regions.length);
  const examples = new Map<string, NotamRecord>(), versions = new Set<string>(), omitted: string[] = [], wider: string[] = [];
  let records = 0, issues = 0;
  const emptyCounts = () => ({ records: 0, candidates: 0, circles: 0, polygons: 0, referenceAreas: 0, gpsOuter: 0,
    tfr: 0, unsupported: 0, activityPoints: 0, obstacleNotices: 0, recoveredAreas: 0, recoveredObstacles: 0 });
  const unique = emptyCounts();
  for (const [index, line] of lines.entries()) {
    const expected = manifest.regions[index]!, snapshot: unknown = JSON.parse(line);
    assert(isNotamRegionSnapshot(snapshot));
    assert.deepEqual(snapshot.query, expected.artccId ? { artccId: expected.artccId } : { firId: expected.firId });
    assert.equal(snapshot.associationCoverage, expected.artccId ? 'complete' : 'incomplete', 'FIR lookup must not claim complete domestic association');
    const counts = emptyCounts(); records += snapshot.records.length; issues += snapshot.issues?.length ?? 0;
    for (const record of snapshot.records) {
      const context = `${record.id}/${record.revision}`, first = !versions.has(context);
      versions.add(context); examples.set(record.id, record);
      if (first) {
        assert.deepEqual(auditNotam(record), [], context + ': source');
        assert.deepEqual(auditMappedNotam(record), [], context + ': mapped source');
        assert.deepEqual(auditRenderedNotam(record, false, manifest.capture.reviewTime), [], context + ': reader');
        assert.deepEqual(auditRenderedNotam(record, true, manifest.capture.reviewTime), [], context + ': mapped reader');
      }
      const item = emptyCounts(); item.records++;
      const area = notamArea(record, references), definition = notamAreaDefinition(record), point = notamActivityPoint(record), obstacle = notamObstacles(record, references);
      if (point) item.activityPoints++; if (obstacle.length) item.obstacleNotices++;
      if (area?.recovered) item.recoveredAreas++; if (obstacle.some(p => p.recovered)) item.recoveredObstacles++;
      const candidate = /AREA DEFINED|RADIUS|POINT OF ORIGIN|AREA (?:IS DEFINED|BOUNDED)|EITHER SIDE OF (?:A )?LINE/i.test(record.text);
      if (candidate) {
        item.candidates++;
        if (/\bTFR\b|TEMPORARY\s+FLIGHT\s+RESTRICTION/i.test(record.text)) {
          assert.equal(area, undefined, context + ': persistent FAA layer owns TFRs'); item.tfr++;
        } else if (area) {
          assert.ok(definition, context);
          if (definition.radius === undefined) item.polygons++;
          else {
            item.circles++;
            for (const p of area.polygons[0]![0]!) assert.ok(Math.abs(distanceNm(area.labelPosition, p) - definition.radius) < 1e-7, context);
          }
          if (definition.locations.some(p => !Array.isArray(p)) || definition.arcs?.length) item.referenceAreas++;
          if (area.outer) item.gpsOuter++;
        } else if (!point) { item.unsupported++; if (first) omitted.push(context); }
      } else if (first && /\d{4,9}(?:\.\d+)?[NSM]\s*\/?\s*\d{5,10}|\b(?:AREA|CIRCLE|BOUNDAR|ARC|CORRIDOR)\b/i.test(record.text) && !area && !obstacle.length && !point) wider.push(context);
      if (area && first) {
        for (const polygon of area.polygons) for (const ring of polygon) {
          assert.deepEqual(ring[0], ring.at(-1), context);
          assert.ok(ring.every(p => p.every(Number.isFinite)), context);
        }
        const features = notamChartFeatures([record], record.startsAt ?? manifest.capture.reviewTime, references).features;
        assert.deepEqual(features.find(f => f.properties.kind === 'area')?.geometry, area.polygons.length === 1
          ? { type: 'Polygon', coordinates: area.polygons[0] } : { type: 'MultiPolygon', coordinates: area.polygons }, context);
      }
      for (const key of Object.keys(item) as (keyof typeof item)[]) { counts[key] += item[key]; if (first) unique[key] += item[key]; }
    }
    assert.deepEqual({ ...snapshot.query, ...counts }, expected);
    assert.equal(JSON.stringify(snapshot), line, 'source mutated');
  }
  assert.deepEqual({ regions: lines.length, records, recordVersions: versions.size, issues }, manifest.totals);
  assert.deepEqual(unique, manifest.unique);
  assert.deepEqual(omitted.sort(), unsupported.map(r => `${r.id}/${r.revision}`).sort(), 'Review every omitted boundary');
  assert.deepEqual(wider.sort(), widerReview.map(r => `${r.id}/${r.revision}`).sort(), 'Review all other coordinate/area prose too');
  const zoa: NotamRecord = JSON.parse(readPinned(manifest.zoaService));
  assert.equal(notamAreaDefinition(zoa)?.radius, 141);
  assert.deepEqual(notamArea(zoa)?.labelPosition, [-125 - 40 / 60 - 53 / 3600, 38 + 43 / 60 + 6 / 3600]);
  assert.equal(notamArea(zoa)?.label, 'ADS-B services may be unavailable\n2000FT-UNL');
  assert.match(examples.get('4102096289613864')!.text, /BULL FIRE/);
  assert.equal(notamArea(examples.get('6610587941015894')!)?.preserveText, true);
  for (const id of ['1791225205578038', '1791305702191031', '9398506527985650', '4162908900810726', '6945670977472300']) assert.ok(notamArea(examples.get(id)!, references), id);
  for (const id of ['3473792392352477', '7785136805319430']) {
    const record = examples.get(id)!;
    assert.equal(notamArea(record, references), undefined, 'ambiguous transport/radius must remain prose');
    assert.equal(chartedNotamPresentation(record), undefined);
  }
  assert.equal(notamArea(examples.get('1768315550338021')!, references), undefined, 'line-wrapped TFR belongs to the national layer');
  for (const id of ['5399917374640846', '6874707614463471', '5900146283777748', '7517312325341400']) {
    const record = examples.get(id)!;
    assert.ok(notamArea(record, references)?.preserveText);
    assert.match(notamArea(record, references)!.label, /See runway-sector qualifications/);
    assert.equal(chartedNotamPresentation(record)!.presentation.searchText, presentNotam(record).searchText);
  }
  const noaa = notamArea(examples.get('1791225205578038')!, references)!;
  assert.ok(noaa.polygons.some(p => p.length > 1), 'NOAA corridor retains interior holes');
  for (const id of ['2861077958468160', '4446007441108563', '4827873480009202']) {
    assert.ok(notamAreaDefinition(examples.get(id)!)?.arcs?.length, 'arc syntax parsed');
    assert.equal(notamArea(examples.get(id)!, references), undefined, 'published clockwise arc self-crosses');
  }
  t.diagnostic(`${manifest.totals.regions} ARTCC/FIR scopes; ${unique.records} unique records; ${unique.circles + unique.polygons} areas; ${unique.unsupported} reviewed boundary omissions`);
});

test('captured Bull Fire TFR keeps the published four-vertex national geometry', () => {
  const snapshot: unknown = JSON.parse(readPinned(manifest.bullFireTfr));
  assert(isTfrSnapshot(snapshot));
  assert.equal(snapshot.notices.length, 1);
  const fire = snapshot.notices[0]!;
  assert.equal(fire.id, '6/7106'); assert.match(fire.text, /BULL FIRE/);
  assert.equal(fire.areas[0]!.lower, 'SFC'); assert.equal(fire.areas[0]!.upper, '10000 ft MSL');
  const features = tfrFeatures({ snapshot, now: manifest.capture.reviewTime, loading: false }).features;
  assert.equal(features.length, 1);
  const ring = features[0]!.geometry.coordinates[0]!;
  assert.equal(ring.length, 5); assert.deepEqual(ring[0], ring.at(-1));
  assert.deepEqual(features[0]!.geometry, fire.areas[0]!.geometry);
  assert.equal(features[0]!.properties.status, 'active');
  const source = lines.map(line => JSON.parse(line)).flatMap(s => s.records)
    .find(r => r.id === '4102096289613864') as NotamRecord;
  assert.equal(chartedTfrReference(source, snapshot.notices), fire);
  for (const changed of [{ ...source, text: source.text + ' ADDITIONAL RESTRICTION', translations: [] },
    { ...source, number: '7107' }, { ...source, startsAt: source.startsAt! + 1000 }, { ...source, lifecycle: 'cancelled' as const },
    { ...source, text: 'AIRSPACE SEE FDC 6/7106', translations: [] }]) assert.equal(chartedTfrReference(changed, snapshot.notices), undefined);
  const render = (chartedTfrs = snapshot.notices) => renderToStaticMarkup(createElement(NotamList,
    { entries: [{ record: source }], now: manifest.capture.reviewTime, chartedTfrs }));
  const abbreviated = render();
  assert.match(abbreviated, /TFR 6\/7106 shown on chart/); assert.match(abbreviated, /SFC–10000 ft MSL/);
  assert.doesNotMatch(abbreviated, /class="notam-readable"/);
  assert.match(abbreviated, /BULL FIRE/); assert.match(abbreviated, /Show raw/);
  assert.match(render([]), /class="notam-readable"/, 'detachment restores the full readable notice');
});

test('every ARTCC obstruction is accounted for as a point, an area or a reviewed malformed coordinate', () => {
  let total = 0, points = 0, areas = 0;
  const omitted: string[] = [], seen = new Set<string>();
  for (const line of lines) {
    const snapshot: unknown = JSON.parse(line); assert(isNotamRegionSnapshot(snapshot));
    for (const record of snapshot.records) {
      if (seen.has(record.id + record.revision)) continue;
      seen.add(record.id + record.revision);
      if (!/^OBST\b/i.test(localNotamContent(parseNotam(record).body, record))) continue;
      total++;
      const parsed = notamObstacles(record, references);
      if (parsed.length) {
        points++;
        assert.ok(parsed.every(p => p.coordinates.every(Number.isFinite)));
        assert.equal(notamChartFeatures([record], record.startsAt!, references).features.filter(f => f.properties.kind === 'obstacle').length, parsed.length);
      } else if (notamArea(record, references)) areas++;
      else omitted.push(`${record.id}/${record.revision}`);
    }
  }
  assert.deepEqual({ total, points, areas }, { total: obstacles.total, points: obstacles.points, areas: obstacles.areas });
  assert.deepEqual(omitted.sort(), obstacles.unsupported.map(r => `${r.id}/${r.revision}`).sort());
});
