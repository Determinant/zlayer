import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { isNotamAirportSnapshot } from '@zlayer/contracts';

// Package an existing sequential capture. No acquisition, parsing or source filtering.
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node --import=tsx tools/pack-notam-corpus.ts CAPTURE_DIRECTORY NEW_FIXTURE_DIRECTORY');
const capture = JSON.parse(await readFile(join(input, 'capture.json'), 'utf8')) as {
  startedAt: string; finishedAt: string; reviewTime: number; endpoint: string;
  airports: { faaId: string; icaoId: string; records: number; sourceIssues: number; snapshotSha256: string }[];
};
assert(Number.isFinite(Date.parse(capture.startedAt)) && Date.parse(capture.finishedAt) >= Date.parse(capture.startedAt));
assert(Number.isSafeInteger(capture.reviewTime) && capture.reviewTime >= 0);
assert(Array.isArray(capture.airports) && capture.airports.length > 0);
assert.equal(new Set(capture.airports.map(a => a.faaId)).size, capture.airports.length, 'Duplicate airport');

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const lines: string[] = [], airports = [], versions = new Set<string>();
const classifications: Record<string, number> = {};
let records = 0, issues = 0, issueVariants = 0;
for (const airport of capture.airports) {
  assert(/^[A-Z0-9]{3,5}$/.test(airport.faaId), 'Invalid FAA identifier');
  const bytes: Buffer = await readFile(join(input, 'snapshots', `${airport.faaId}.json`));
  assert.equal(sha256(bytes), airport.snapshotSha256, `${airport.faaId}: original capture changed`);
  const snapshot: unknown = JSON.parse(bytes.toString('utf8'));
  assert(isNotamAirportSnapshot(snapshot), `${airport.faaId}: invalid snapshot`);
  assert.deepEqual(snapshot.query, { faaId: airport.faaId, ...(airport.icaoId ? { icaoId: airport.icaoId } : {}) });
  assert.equal(snapshot.records.length, airport.records, `${airport.faaId}: record count`);
  assert.equal(snapshot.issues?.length ?? 0, airport.sourceIssues, `${airport.faaId}: source issue count`);
  for (const record of snapshot.records) {
    classifications[record.classification] = (classifications[record.classification] ?? 0) + 1;
    versions.add(`${record.id}:${record.revision}`);
  }
  records += snapshot.records.length;
  issues += snapshot.issues?.length ?? 0;
  issueVariants += snapshot.issues?.reduce((sum, issue) => sum + issue.variants.length, 0) ?? 0;
  airports.push({ ...snapshot.query, records: snapshot.records.length, issues: snapshot.issues?.length ?? 0 });
  lines.push(JSON.stringify(snapshot)); // Preserve every field, raw string, translation and source issue.
}
const payload = Buffer.from(lines.join('\n') + '\n'), compressed = gzipSync(payload, { level: 9 });
const manifest = {
  schemaVersion: 1,
  source: 'FAA NMS airport-location snapshots',
  capture: { startedAt: capture.startedAt, finishedAt: capture.finishedAt, reviewTime: capture.reviewTime,
    endpoint: capture.endpoint, airportManifestSha256: sha256(await readFile(join(input, 'manifest.json'))) },
  payload: { file: 'snapshots.jsonl.gz', bytes: payload.length, sha256: sha256(payload) },
  totals: { airports: airports.length, records, recordVersions: versions.size, issues, issueVariants, classifications },
  airports,
};
await mkdir(output); // Refuse to overwrite a fixture or an earlier candidate.
await writeFile(join(output, manifest.payload.file), compressed);
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ...manifest.totals, compressedBytes: compressed.length }));
