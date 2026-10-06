import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { isNotamAirportSnapshot } from '@zlayer/contracts';
import { parseNotam } from '../src/layers/notams/parser';
import { notamFlairs } from '../src/layers/notams/flairs';
import { auditNotam, auditMappedNotam, auditRenderedNotam } from '../tools/audit-notams';
import manifest from './fixtures/notams-us1000/manifest.json' with { type: 'json' };

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
