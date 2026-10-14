import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

// Pinned source, scope and refresh instructions: pireps/station-references.md.
const [input] = process.argv.slice(2);
assert.ok(input && process.argv.length === 3, 'Pass the AWC stations.cache.json.gz file');
const bytes = gunzipSync(await readFile(input), { maxOutputLength: 8 * 1024 * 1024 });
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256, '63c3d39b73de7a0cfa1b5cc5889dff61c9b1e9ba3b394673f3765804d92f1945', 'Unexpected AWC station revision');
const rows = JSON.parse(bytes.toString('utf8'));
assert.ok(Array.isArray(rows) && rows.length === 9947, 'Incomplete station collection');
const stations = new Map();
const unavailable = [];
for (const row of rows) {
  if (typeof row.icaoId !== 'string' || !/^[A-Z]{4}$/.test(row.icaoId) || !row.country || row.country === 'US' ||
      !row.siteType.some(type => type === 'METAR' || type === 'TAF')) continue;
  if (!Number.isFinite(row.lon) || Math.abs(row.lon) > 180 || !Number.isFinite(row.lat) || Math.abs(row.lat) > 90) {
    unavailable.push(row.icaoId); continue;
  }
  assert.ok(!stations.has(row.icaoId), `Duplicate station ${row.icaoId}`);
  stations.set(row.icaoId, [row.lon, row.lat]);
}
assert.deepEqual(unavailable.sort(), ['HERT', 'HTJN', 'MMGA', 'OERS', 'VEHO', 'WAFB'], 'Changed missing-coordinate entries');
assert.equal(stations.size, 4957, 'Unexpected international reference coverage');
const output = '{\n' + [...stations].sort(([a], [b]) => a.localeCompare(b))
  .map(([ident, coordinate]) => `  ${JSON.stringify(ident)}: ${JSON.stringify(coordinate)}`).join(',\n') + '\n}\n';
await writeFile(new URL('../src/layers/weather-awc/pireps/station-references.json', import.meta.url), output);
