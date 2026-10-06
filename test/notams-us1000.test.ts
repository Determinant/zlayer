import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { isNotamAirportSnapshot, isGeoPointFeature, type NavigationData } from '@zlayer/contracts';
import { localNotamContent, parseNotam } from '../src/layers/notams/parser';
import { notamObstacles } from '../src/layers/notams/obstacles';
import { notamArea } from '../src/layers/notams/areas';
import { notamChartFeatures } from '../src/layers/notams/chart';
import { createNotamAreaReferences } from '../src/layers/notams/area-references';
import { notamFlairs } from '../src/layers/notams/flairs';
import { auditNotam, auditMappedNotam, auditRenderedNotam } from '../tools/audit-notams';
import manifest from './fixtures/notams-us1000/manifest.json' with { type: 'json' };
import obstructions from './fixtures/notams-us1000/obstructions.json' with { type: 'json' };

test('all 1,000 captured airports preserve source content, value bindings, flair evidence and both readers', t => {
  const payload = gunzipSync(readFileSync(new URL(`./fixtures/notams-us1000/${manifest.payload.file}`, import.meta.url)),
    { maxOutputLength: manifest.payload.bytes });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(payload.length, manifest.payload.bytes);
  assert.equal(createHash('sha256').update(payload).digest('hex'), manifest.payload.sha256, 'Frozen corpus changed');
  const lines = payload.toString('utf8').trimEnd().split('\n');
  assert.equal(lines.length, 1000);
  assert.equal(manifest.airports.length, lines.length);
  assert.equal(new Set(manifest.airports.map(a => a.faaId)).size, lines.length);

  const versions = new Set<string>(), classifications: Record<string, number> = {};
  let records = 0, issues = 0, issueVariants = 0;
  for (const [index, line] of lines.entries()) {
    const airport = manifest.airports[index]!;
    const snapshot: unknown = JSON.parse(line);
    assert(isNotamAirportSnapshot(snapshot), `${airport.faaId}: invalid snapshot`);
    assert.deepEqual(snapshot.query, { faaId: airport.faaId, ...('icaoId' in airport ? { icaoId: airport.icaoId } : {}) });
    assert.equal(snapshot.records.length, airport.records, `${airport.faaId}: record count`);
    assert.equal(snapshot.issues?.length ?? 0, airport.issues, `${airport.faaId}: source issue count`);

    for (const record of snapshot.records) {
      const context = `${airport.faaId} / ${record.id} / ${record.revision}`;
      try {
        // Run the independent audit before other derivations can populate caches.
        assert.deepEqual(auditNotam(record), [], 'content / values');
        assert.deepEqual(auditRenderedNotam(record, false, manifest.capture.reviewTime), [], 'reader');
        assert.deepEqual(auditMappedNotam(record), [], 'mapped content');
        assert.deepEqual(auditRenderedNotam(record, true, manifest.capture.reviewTime), [], 'mapped reader');
        const parsed = parseNotam(record);
        for (const flair of notamFlairs(parsed)) {
          assert.ok(flair.evidence.length > 0, `unsupported flair ${flair.label}`);
          for (const span of flair.evidence) assert.equal(parsed.body.slice(span.start, span.end), span.text, 'flair evidence');
        }
      } catch (error) {
        throw new Error(`${context}: corpus replay failed`, { cause: error });
      }
      records++;
      versions.add(`${record.id}:${record.revision}`);
      classifications[record.classification] = (classifications[record.classification] ?? 0) + 1;
    }
    issues += snapshot.issues?.length ?? 0;
    issueVariants += snapshot.issues?.reduce((sum, issue) => sum + issue.variants.length, 0) ?? 0;
    assert.equal(JSON.stringify(snapshot), line, `${airport.faaId}: source snapshot mutated`);
  }
  assert.equal(records, 19469);
  assert.deepEqual({ airports: lines.length, records, recordVersions: versions.size, issues, issueVariants, classifications }, manifest.totals);
  t.diagnostic(`${lines.length} airports; ${records} records; ${issues} source issues retained separately; no audit findings`);
});

test('every airport obstruction has verified map output or an explicitly reviewed source/scope limitation', t => {
  const referenceBytes = readFileSync(new URL(`./fixtures/notams-us1000/${obstructions.references.file}`, import.meta.url));
  assert.equal(referenceBytes.length, obstructions.references.bytes);
  assert.equal(createHash('sha256').update(referenceBytes).digest('hex'), obstructions.references.sha256);
  const source = JSON.parse(referenceBytes.toString()), navigation: NavigationData = {};
  for (const id of ['airports', 'navaids'] as const) {
    assert.equal(source[id].length, obstructions.references[id]);
    assert.ok(source[id].every(isGeoPointFeature));
    navigation[id] = { type: 'FeatureCollection', features: source[id], meta: {
      layer: id, revision: source.effectiveDate, returned: source[id].length, truncated: false } };
  }
  const references = createNotamAreaReferences(navigation);
  const payload = gunzipSync(readFileSync(new URL(`./fixtures/notams-us1000/${manifest.payload.file}`, import.meta.url)), { maxOutputLength: manifest.payload.bytes });
  assert.equal(createHash('sha256').update(payload).digest('hex'), manifest.payload.sha256);
  const counts = { standalone: 0, points: 0, areas: 0, unresolved: 0, otherCandidates: 0, otherDepicted: 0, otherUnresolved: 0 };
  const omitted: string[] = [];
  for (const line of payload.toString().trimEnd().split('\n')) {
    const snapshot: unknown = JSON.parse(line); assert(isNotamAirportSnapshot(snapshot));
    for (const record of snapshot.records) {
      const body = parseNotam(record).body, content = localNotamContent(body, record), key = `${record.id}/${record.revision}`;
      // Inventory source wording independently of the point parser's accepted kinds.
      const standalone = /^OBST\b/i.test(content);
      const other = !standalone && /\b(?:CRANE|TOWER|WINDMILL|OBSTACLE|OBSTRUCTION)S?\b/i.test(content) &&
        /\d{4,9}(?:\.\d+)?[NSM]\s*\/?\s*\d{5,10}/.test(content);
      if (!standalone && !other) continue;
      const points = notamObstacles(record, references), area = notamArea(record, references);
      if (standalone) {
        counts.standalone++;
        if (points.length) counts.points++; else if (area) counts.areas++; else counts.unresolved++;
      } else { counts.otherCandidates++; if (points.length || area) counts.otherDepicted++; else counts.otherUnresolved++; }
      if (!points.length && !area) { omitted.push(key); continue; }
      const features = notamChartFeatures([record], record.startsAt ?? manifest.capture.reviewTime, references).features;
      for (const point of points) {
        // Decode the exact published DMS/minute fields independently. This catches
        // substituted airport centers, wrong hemispheres and lost fractional seconds.
        const token = body.slice(point.coordinateSpan.start, point.coordinateSpan.end).toUpperCase();
        const dms = /^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)?([NS])\s*\/?\s*(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)?([EW])$/.exec(token);
        assert.ok(dms, key + ': unsupported coordinate needs independent expected position');
        const expected = [(Number(dms[5]) + Number(dms[6]) / 60 + Number(dms[7] ?? 0) / 3600) * (dms[8] === 'W' ? -1 : 1),
          (Number(dms[1]) + Number(dms[2]) / 60 + Number(dms[3] ?? 0) / 3600) * (dms[4] === 'S' ? -1 : 1)];
        assert.deepEqual(point.coordinates, expected, key);
        if (Number(dms[3]) === 60 || Number(dms[7]) === 60) assert.equal(point.recovered, true, key);
        if (!['cancelled', 'cancellation'].includes(record.lifecycle)) assert.ok(features.some(f => f.properties.kind === 'obstacle' &&
          f.geometry.type === 'Point' && f.geometry.coordinates.every((value, i) => value === expected[i])), key + ': point not published');
      }
      if (area && !['cancelled', 'cancellation'].includes(record.lifecycle)) assert.ok(features.some(f => f.properties.kind === 'area'), key + ': area not published');
    }
    assert.equal(JSON.stringify(snapshot), line, 'source mutated');
  }
  assert.deepEqual(counts, obstructions.counts);
  assert.deepEqual(omitted.sort(), obstructions.unsupported.map(r => `${r.id}/${r.revision}`).sort());
  t.diagnostic(`${counts.standalone} OBST notices: ${counts.points} point notices, ${counts.areas} areas, ${counts.unresolved} reviewed omissions; ${counts.otherDepicted}/${counts.otherCandidates} other explicit obstruction reports depicted`);
});
