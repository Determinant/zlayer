import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotamAirportSnapshot } from '@zlayer/contracts';

// Read prepared API snapshots only. This does not acquire FAA data or force a feed refresh.
const [manifestPath, directory, endpoint = 'https://zlayer.tedyin.com/api/notams/airports'] = process.argv.slice(2);
if (!manifestPath || !directory) throw new Error('Usage: node --import=tsx tools/capture-notams.ts MANIFEST.json NEW_DIRECTORY [AIRPORT_API_URL]');
const manifestText = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText) as { airports: { faaId: string; icaoId: string }[] };
if (!Array.isArray(manifest.airports) || !manifest.airports.length || manifest.airports.some(a =>
  !/^[A-Z0-9]{2,5}$/.test(a.faaId) || !/^[A-Z0-9]{4}$/.test(a.icaoId))) throw new Error('Invalid airport manifest');
if (new Set(manifest.airports.map(a => a.icaoId)).size !== manifest.airports.length) throw new Error('Duplicate airport in manifest');
await mkdir(directory); // Refuse to replace an earlier capture.
await writeFile(join(directory, 'manifest.json'), manifestText);
const startedAt = new Date().toISOString(), queue = [...manifest.airports];
const results: { faaId: string; icaoId: string; records?: number; error?: string }[] = [];
await Promise.all(Array.from({ length: 3 }, async () => {
  for (let airport = queue.shift(); airport; airport = queue.shift()) {
    try {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({ faaId: airport.faaId, icaoId: airport.icaoId }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot: unknown = await response.json();
      if (!isNotamAirportSnapshot(snapshot) || snapshot.query.faaId !== airport.faaId || snapshot.query.icaoId !== airport.icaoId) {
        throw new Error('Invalid snapshot or airport identity');
      }
      await writeFile(join(directory, `${airport.icaoId}.json`), JSON.stringify(snapshot, null, 2) + '\n');
      results.push({ faaId: airport.faaId, icaoId: airport.icaoId, records: snapshot.records.length });
    } catch (error) {
      results.push({ faaId: airport.faaId, icaoId: airport.icaoId, error: String(error) });
    }
  }
}));
results.sort((a, b) => a.icaoId.localeCompare(b.icaoId));
await writeFile(join(directory, 'capture.json'), JSON.stringify({ startedAt, capturedAt: new Date().toISOString(), endpoint, airports: results }, null, 2) + '\n');
const errors = results.filter(result => result.error);
console.log(JSON.stringify({ airports: results.length, records: results.reduce((sum, result) => sum + (result.records ?? 0), 0), errors }, null, 2));
if (errors.length) process.exitCode = 1;
