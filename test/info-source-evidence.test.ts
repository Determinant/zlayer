import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createSourceEvidence } from '../tools/info-server/source-evidence';
import { createUpstream, digest } from '../tools/info-server/upstream';
import { advisoryResource } from '../tools/info-server/weather-resources';
import { readGairmetCache } from '../tools/info-server/gairmet';
import { gairmetXml } from './fixtures/gairmet-cache';
import { advisorySource, WEATHER_NOW } from './fixtures/awc-advisories';

test('rejected exact download survives with source metadata and checksum and replays the original diagnostic offline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'source-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = createSourceEvidence(directory, { sourceUrl: 'https://example.test/source/info-test.tar.gz' });
  const bytes = gzipSync('<response>broken'); let calls = 0;
  const upstream = createUpstream({ signal: new AbortController().signal, now: () => WEATHER_NOW, spacing: 0, evidence,
    fetch: async () => { calls++; return new Response(Uint8Array.from(bytes), { headers: { 'last-modified': new Date(WEATHER_NOW).toUTCString() } }); } });
  let id = '';
  await assert.rejects(upstream(advisoryResource('gairmet')), (error: any) => {
    assert.match(error.message, /malformed XML/); id = error.evidenceId; assert.match(id, /^[a-f0-9]{64}$/); return true;
  });
  await assert.rejects(upstream(advisoryResource('gairmet'))); await evidence.close();
  assert.equal((await readdir(join(directory, 'source-failures'))).length, 2, 'identical observations deduplicate');
  const raw = await readFile(join(directory, 'source-failures', id + '.bin'));
  const meta = JSON.parse(await readFile(join(directory, 'source-failures', id + '.json'), 'utf8'));
  assert.deepEqual(raw, bytes); assert.equal(meta.sha256, digest(raw)); assert.equal(meta.byteLength, raw.length);
  assert.equal(meta.requestedAt, WEATHER_NOW); assert.equal(meta.source, advisoryResource('gairmet').url);
  assert.match(meta.releaseSource, /info-test/); assert.ok(meta.headers['last-modified']);
  assert.equal((await stat(join(directory, 'source-failures', id + '.bin'))).mode & 0o777, 0o600);
  await assert.rejects(readGairmetCache(raw), /malformed XML/); assert.equal(calls, 2, 'offline replay never acquires a source');
});

test('member interpretation failures retain complete raw bytes without preventing partial publication', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'source-members-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = gzipSync(gairmetXml([0, 3, 6, 9, 12].map(hour => advisorySource('gairmet', hour))).replace('<geometry_type>AREA</geometry_type>', '<geometry_type>UNKNOWN</geometry_type>'));
  const evidence = createSourceEvidence(directory);
  const upstream = createUpstream({ signal: new AbortController().signal, now: () => WEATHER_NOW, spacing: 0, evidence,
    fetch: async () => new Response(Uint8Array.from(bytes), { headers: { 'last-modified': new Date(WEATHER_NOW).toUTCString() } }) });
  const value = await upstream(advisoryResource('gairmet'));
  assert.match(value.headers['x-weather-evidence']!, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(join(directory, 'source-failures', value.headers['x-weather-evidence'] + '.bin')), bytes);
});

test('evidence retention is bounded, removes interrupted files, and cannot turn diagnostic IO failure into source success', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'source-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = createSourceEvidence(directory), root = join(directory, 'source-failures');
  const meta = { source: advisoryResource('gairmet').url, requestedAt: WEATHER_NOW, checkedAt: WEATHER_NOW,
    headers: {}, phase: 'download-validation' as const, rule: 'test-rule' };
  await evidence.capture(Buffer.from('first'), meta);
  await writeFile(join(root, 'a'.repeat(64) + '.bin'), 'interrupted');
  await writeFile(join(root, 'b'.repeat(64) + '.bin.tmp'), 'interrupted');
  for (let i = 0; i < 12; i++) await evidence.capture(Buffer.from(String(i)), { ...meta, requestedAt: WEATHER_NOW + i });
  const files = await readdir(root); assert.equal(files.length, 14); assert.ok(files.every(name => !name.endsWith('.tmp')));
  const blocked = join(directory, 'blocked'); await writeFile(blocked, 'not a directory');
  assert.equal(await createSourceEvidence(blocked).capture(Buffer.from('raw'), meta), undefined);
  const upstream = createUpstream({ signal: new AbortController().signal, now: () => WEATHER_NOW, evidence: createSourceEvidence(blocked),
    fetch: async () => new Response(Uint8Array.from(gzipSync('<response>broken')), { headers: { 'last-modified': new Date(WEATHER_NOW).toUTCString() } }) });
  await assert.rejects(upstream(advisoryResource('gairmet')), /malformed XML/);
});
