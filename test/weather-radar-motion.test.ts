import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRadarMotionCatalog, isRadarMotionSnapshot, RADAR_HISTORY_MS, RADAR_MAX_AGE, RADAR_MOTION_ROOT, type RadarMotionCatalog } from '@zlayer/contracts';
import { decodeStormTracks } from '../tools/weather-server/radar-motion-decode';
import { createRadarMotionWarming } from '../tools/weather-server/radar-motion';
import { WeatherCache } from '../tools/weather-server/cache';
import { digest } from '../tools/weather-server/upstream';
import { resourceFor } from '../tools/weather-server/routes';
import { motionFile, motionScans } from '../src/layers/weather-awc/radar/motion-time';

const capture = (name: string) => readFile(new URL(`./fixtures/radar/${name}`, import.meta.url));
test('STI retains native forecast positions and interval, accepts empty reports, and rejects station or packet mismatches', async () => {
  const raw = await capture('20260924-012552-ktlx-sti.level3'), scan = decodeStormTracks(raw, 'KTLX', digest(raw));
  assert.equal(scan.observedAt, Date.parse('2026-09-24T01:25:52Z'));
  assert.ok(isRadarMotionSnapshot({ schemaVersion: 1, scans: [scan] }));
  assert.deepEqual(scan.tracks.map(t => [t.id, t.intervalMinutes, t.coordinates.length]), [['N1', 15, 5], ['I1', 15, 5]]);
  // Source tabular block independently reports N1 at 240 degrees/117 nm,
  // then 250 degrees/99 nm at +60 minutes. Geographic quadrants must agree.
  const track = scan.tracks[0]!;
  assert.ok(track.coordinates[0]![0] < -99 && track.coordinates[0]![1] < 35);
  assert.ok(track.coordinates.at(-1)![0] > track.coordinates[0]![0] && track.coordinates.at(-1)![1] > track.coordinates[0]![1]);
  const empty = await capture('20260924-210657-khtx-sti.level3');
  assert.deepEqual(decodeStormTracks(empty, 'KHTX', digest(empty)).tracks, []);
  const mixed = await capture('20260924-211024-kamx-sti.level3');
  assert.deepEqual(decodeStormTracks(mixed, 'KAMX', digest(mixed)).tracks.map(t => t.id), ['N5'], 'NEW cell R1 has no projected movement');
  assert.throws(() => decodeStormTracks(raw, 'KAMX', digest(raw)));
  assert.throws(() => decodeStormTracks(raw.subarray(0, 100), 'KTLX', digest(raw)));
  const corrupt = Buffer.from(raw); corrupt.writeUInt32BE(0x7fffffff, 30 + 116);
  assert.throws(() => decodeStormTracks(corrupt, 'KTLX', digest(corrupt)));
});

test('motion uses saved historical collections and never newer, stale or future observation vectors', async () => {
  const raw = await capture('20260924-012552-ktlx-sti.level3'), scan = decodeStormTracks(raw, 'KTLX', digest(raw));
  const now = scan.observedAt + 5 * 60_000, hash = 'a'.repeat(64);
  const catalog: RadarMotionCatalog = { schemaVersion: 1, checkedAt: now, unavailable: [], files: [
    { availableAt: now - 120_000, path: `motion/${hash}.json`, sha256: hash, byteLength: 123 },
    { availableAt: now, path: `motion/${hash}.json`, sha256: hash, byteLength: 123 },
  ] };
  assert.ok(isRadarMotionCatalog(catalog));
  assert.equal(motionFile(catalog, now - 60_000, now), catalog.files[0]);
  assert.equal(motionFile(catalog, now + 1, now), undefined);
  assert.equal(motionFile(catalog, null, now + RADAR_HISTORY_MS), undefined);
  assert.deepEqual(motionScans([scan], now, now), [scan]);
  assert.deepEqual(motionScans([scan], scan.observedAt - 1, now), []);
  assert.deepEqual(motionScans([scan], scan.observedAt + RADAR_MAX_AGE, now), []);
  assert.deepEqual(motionScans([scan], now, scan.observedAt + RADAR_HISTORY_MS), []);
  assert.equal(isRadarMotionCatalog({ ...catalog, files: [...catalog.files].reverse() }), false);
  assert.throws(() => resourceFor('/api/weather/radar/motion/latest.json?time=now'));
});

test('background motion publication reuses unchanged artifacts and restores them without upstream reads', async t => {
  const raw = await capture('20260924-012552-ktlx-sti.level3');
  let now = Date.parse('2026-09-24T01:30:00Z'), reads = 0;
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-motion-')), signal = new AbortController().signal;
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new WeatherCache({ directory, maxBytes: 16 * 1024 * 1024, now: () => now, async load(resource) {
    reads++;
    const body = resource.url === RADAR_MOTION_ROOT ? Buffer.from('<html><a href="SI.ktlx/">KTLX</a></html>') : raw;
    return { body, sha256: digest(body), status: 200, checkedAt: now, headers: { 'content-type': 'application/octet-stream' } };
  } });
  await cache.restore();
  const warmer = createRadarMotionWarming(cache, signal, { now: () => now });
  const readCatalog = async () => {
    const saved = await cache.read(resourceFor('/api/weather/radar/motion/latest.json'));
    const value: unknown = JSON.parse(saved!.body.toString()); assert.ok(isRadarMotionCatalog(value)); return value;
  };
  warmer.refresh(); await warmer.close();
  const first = await readCatalog(); assert.equal(first.files.length, 1);
  now += 120_001; warmer.refresh(); await warmer.close();
  const second = await readCatalog(); assert.deepEqual(second.files, first.files);
  const priorReads = reads, restored = createRadarMotionWarming(cache, signal, { now: () => now });
  await restored.restore(); assert.equal(restored.status.stations, 1); assert.equal(reads, priorReads);
  now += RADAR_MAX_AGE; restored.refresh(); await restored.close();
  assert.deepEqual((await readCatalog()).unavailable, ['KTLX']);
  await cache.drain();
});
