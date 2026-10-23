import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { NotamStore } from '../tools/info-server/notams/store';
import { NotamBulkSource, readArchivedNotamBulk } from '../tools/info-server/notams/bulk-source';
import { NotamReconciliation } from '../tools/info-server/notams/reconciliation';
import { NotamError } from '../tools/info-server/notams/error';
import { createNotamService } from '../tools/info-server/notams/service';
import { createNotamXmlParser } from '../tools/info-server/notams/normalize';
import { workerJob } from '../tools/info-server/worker-job';
import { bulkXml, notice, NOTAM_NOW } from './fixtures/notams';
import { replayNotamBulk } from '../tools/replay-notam-bulk';

const archives = async (directory: string) => (await readdir(join(directory, 'bulk-archive')))
  .filter(name => name.endsWith('.json')).sort().map(name => join(directory, 'bulk-archive', name));

for (const corruption of ['bytes', 'manifest', 'missing'] as const) test(`saved bulk rejects ${corruption} corruption without changing admission`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-bulk-'));
  const store = new NotamStore(directory, 'production', () => NOTAM_NOW);
  try {
    await store.restore(); await store.admission.reserve('bulk');
    const budget = await readFile(join(directory, 'budget.json'));
    const source = new NotamBulkSource(store, () => NOTAM_NOW), path = join(directory, 'download.tmp');
    await writeFile(path, gzipSync(bulkXml([notice()])));
    const saved = await source.save(path, NOTAM_NOW);
    assert.deepEqual(await source.restore(null), saved);
    if (corruption === 'bytes') await writeFile(saved.path, 'different');
    else if (corruption === 'missing') await rm(saved.path);
    else {
      const manifest = JSON.parse(await readFile(join(directory, 'bulk-source.json'), 'utf8'));
      manifest.requestedAt++;
      await writeFile(join(directory, 'bulk-source.json'), JSON.stringify(manifest));
    }
    await assert.rejects(source.restore(null), /invalid-bulk-source/);
    await source.discard();
    assert.deepEqual(await readFile(join(directory, 'budget.json')), budget);
    assert.equal((await readdir(directory)).some(name => name.startsWith('bulk-source')), false);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('bulk recovery keeps one source and retires expired, future, or already published checkpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-bulk-')); let now = NOTAM_NOW;
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore(); const source = new NotamBulkSource(store, () => now);
    for (const text of ['first', 'second']) {
      const path = join(directory, 'download.tmp'); await writeFile(path, text); await source.save(path, now);
    }
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.bin')).length, 1);
    const budget = await readFile(join(directory, 'budget.json'));
    for (const condition of ['expired', 'future', 'published'] as const) {
      now = NOTAM_NOW;
      const path = join(directory, 'download.tmp'); await writeFile(path, 'saved'); await source.save(path, now);
      if (condition === 'expired') now += 86_400_000;
      if (condition === 'future') now--;
      assert.equal(await source.restore(condition === 'published' ? NOTAM_NOW : null), undefined);
      assert.equal((await readdir(directory)).some(name => name.startsWith('bulk-source')), false);
    }
    assert.deepEqual(await readFile(join(directory, 'budget.json')), budget);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const name of ['bulk-source.json', 'bulk-source-' + 'a'.repeat(64) + '.bin', 'bulk-archive', 'delta-failures']) test(`orphaned ${name} cannot provision another allowance`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-bulk-'));
  const store = new NotamStore(directory, 'production');
  try {
    if (name === 'bulk-archive' || name === 'delta-failures') await mkdir(join(directory, name)); else await writeFile(join(directory, name), '{}');
    await assert.rejects(store.restore(), /state-recovery-required/);
    assert.equal((await readdir(directory)).includes('budget.json'), false);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('archive retains seven exact downloads across success, rejection, expiry and restart without granting replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-bulk-archive-'));
  let now = NOTAM_NOW;
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore(); await store.admission.reserve('bulk');
    const budget = await readFile(join(directory, 'budget.json'));
    const sourceUrl = 'https://example.test/source/installed.tar.gz';
    const source = new NotamBulkSource(store, () => now, sourceUrl), inputs = new Map<number, Buffer>();
    for (let index = 0; index < 10; index++) {
      now = NOTAM_NOW + index * 86_400_000;
      // Completed downloads stay useful for debugging even when their XML is invalid.
      const body = index === 8 ? Buffer.from('invalid XML for diagnosis') : gzipSync(bulkXml([notice({ text: `source ${index}` })], now));
      inputs.set(now, body);
      const path = join(directory, 'download.tmp'); await writeFile(path, body, { mode: 0o600 });
      const saved = await source.save(path, now);
      const archive = (await archives(directory)).at(-1)!;
      const metadata = await readArchivedNotamBulk(archive);
      assert.equal((await stat(metadata.path)).ino, (await stat(saved.path)).ino, 'archive shares immutable bytes with recovery checkpoint');
      assert.equal(metadata.sourceUrl, sourceUrl);
      // Removing recovery authority must never delete archived diagnostic bytes.
      await source.discard();
    }
    const kept = await archives(directory);
    assert.equal(kept.length, 7);
    assert.equal((await readdir(join(directory, 'bulk-archive'))).length, 14);
    for (const path of kept) {
      const saved = await readArchivedNotamBulk(path);
      assert.ok(saved.requestedAt >= NOTAM_NOW + 3 * 86_400_000);
      assert.deepEqual(await readFile(saved.path), inputs.get(saved.requestedAt));
      assert.equal(saved.environment, 'production');
    }
    now += 8 * 86_400_000;
    const orphan = `${now}-${'f'.repeat(64)}`;
    await writeFile(join(directory, 'bulk-archive', `${orphan}.bin`), 'interrupted archive');
    await writeFile(join(directory, 'bulk-archive', `${orphan}.json.12345678-abcd.tmp`), 'interrupted metadata');
    await writeFile(join(directory, 'bulk-archive', 'operator-notes.txt'), 'keep unrelated files');
    const restored = new NotamBulkSource(store, () => now, 'https://example.test/source/new.tar.gz');
    assert.equal(await restored.restore(null), undefined, 'archives alone cannot become a live recovery checkpoint');
    assert.deepEqual(await archives(directory), kept, 'debug retention is count-based, not the live replay window');
    assert.equal(await readFile(join(directory, 'bulk-archive', 'operator-notes.txt'), 'utf8'), 'keep unrelated files');
    assert.equal((await readdir(join(directory, 'bulk-archive'))).length, 15);
    assert.deepEqual(await readFile(join(directory, 'budget.json')), budget);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('legacy replay checkpoints are archived before retirement with unknown acquisition release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-bulk-legacy-'));
  const store = new NotamStore(directory, 'production', () => NOTAM_NOW);
  try {
    await store.restore(); const source = new NotamBulkSource(store, () => NOTAM_NOW);
    const path = join(directory, 'download.tmp'); const body = gzipSync(bulkXml([notice()]));
    await writeFile(path, body); await source.save(path, NOTAM_NOW);
    await rm(join(directory, 'bulk-archive'), { recursive: true }); // Previous release had only the recovery checkpoint.
    assert.equal(await source.restore(NOTAM_NOW), undefined);
    const archived = await readArchivedNotamBulk((await archives(directory))[0]!);
    assert.equal(archived.sourceUrl, null);
    assert.deepEqual(await readFile(archived.path), body);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const corruption of ['bytes', 'manifest'] as const) test(`offline archive replay rejects changed ${corruption}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-bulk-debug-'));
  const store = new NotamStore(directory, 'production', () => NOTAM_NOW);
  try {
    await store.restore(); const path = join(directory, 'download.tmp'); await writeFile(path, gzipSync(bulkXml([notice()])));
    await new NotamBulkSource(store, () => NOTAM_NOW).save(path, NOTAM_NOW);
    const archive = (await archives(directory))[0]!, saved = await readArchivedNotamBulk(archive);
    if (corruption === 'bytes') await writeFile(saved.path, 'changed');
    else {
      const metadata = JSON.parse(await readFile(archive, 'utf8')); metadata.requestedAt++;
      await writeFile(archive, JSON.stringify(metadata));
    }
    await assert.rejects(replayNotamBulk(archive, join(directory, 'debug')), /invalid-bulk-source/);
    assert.equal((await readdir(directory)).includes('debug'), false);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('offline replay parses an expired archive without changing its bytes, source times or admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-bulk-offline-'));
  let now = NOTAM_NOW;
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore(); await store.admission.reserve('bulk');
    const path = join(directory, 'download.tmp'), body = gzipSync(bulkXml([notice()]));
    await writeFile(path, body); const source = new NotamBulkSource(store, () => now, 'https://example.test/original.tar.gz');
    await source.save(path, now); now += 2 * 86_400_000;
    assert.equal(await new NotamBulkSource(store, () => now, 'https://example.test/new.tar.gz').restore(null), undefined);
    const archive = (await archives(directory))[0]!, before = await readFile(archive), budget = await readFile(join(directory, 'budget.json'));
    const result = await replayNotamBulk(archive, join(directory, 'debug'));
    assert.equal(result.count, 1); assert.equal(result.snapshotAt, NOTAM_NOW);
    assert.equal(result.source.requestedAt, NOTAM_NOW);
    assert.equal(result.source.sourceUrl, 'https://example.test/original.tar.gz');
    assert.equal(JSON.parse(await readFile(join(directory, 'debug/records.ndjson'), 'utf8')).text, notice().text);
    assert.deepEqual(await readFile(result.source.path), body);
    assert.deepEqual(await readFile(archive), before);
    assert.deepEqual(await readFile(join(directory, 'budget.json')), budget);
    await assert.rejects(replayNotamBulk(archive, join(directory, 'debug')), /EEXIST/);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const valid of [true, false]) test(`collector archives a ${valid ? 'successful' : 'rejected'} bulk through restart without another bulk request`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'notam-bulk-collector-')), directory = join(root, 'production');
  let now = NOTAM_NOW, bulkRequests = 0;
  const body = valid ? gzipSync(bulkXml([notice()])) : Buffer.from('<invalid');
  const options = { enabled: true, environment: 'production' as const, directory: root, credentials: { clientId: 'fixture', clientSecret: 'fixture' } };
  const dependencies = { signal: new AbortController().signal, now: () => now, wait: async (ms: number) => { now += ms; },
    sourceUrl: 'https://example.test/source/deployed.tar.gz', fetch: (async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/v1/auth/token')) return Response.json({ access_token: 'fixture', expires_in: '1799' });
      if (url.pathname.endsWith('/notams/il')) {
        bulkRequests++; return Response.json({ status: 'Success', data: { url: '/nmsapi/v1/content/fixture' } });
      }
      if (url.pathname.endsWith('/content/fixture')) return new Response(body);
      assert.ok(url.searchParams.has('lastUpdatedDate'));
      return Response.json({ status: 'Success', data: { aixm: [] } });
    }) as typeof fetch };
  let service = createNotamService(options, dependencies);
  try {
    await service.restore(); service.refresh(); await service.settled();
    assert.equal(bulkRequests, 1);
    const archive = (await archives(directory))[0]!, saved = await readArchivedNotamBulk(archive);
    assert.deepEqual(await readFile(saved.path), body);
    assert.equal(saved.sourceUrl, dependencies.sourceUrl);
    assert.equal((await readdir(directory)).some(name => name.startsWith('bulk-source')), false);
    const budget = JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8'));
    await service.close(); now += 181_000;
    service = createNotamService(options, dependencies); await service.restore();
    assert.equal(service.reconciliation?.pending, valid);
    service.refresh(); await service.settled();
    assert.equal(bulkRequests, 1);
    if (valid) {
      assert.equal(service.status.state, 'ready');
      assert.equal(service.reconciliation?.error, null);
    } else {
      assert.equal(service.reconciliation?.state, 'failed');
      const debug = join(root, 'debug');
      await assert.rejects(replayNotamBulk(archive, debug));
      assert.equal(JSON.parse(await readFile(join(debug, 'result.json'), 'utf8')).outcome, 'failed');
    }
    assert.deepEqual(await readFile(saved.path), body);
    assert.equal(JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8')).bulkAt, budget.bulkAt);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('restart replays the authenticated bulk locally, then bridges within the existing allowance and clears failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notam-bulk-replay-')), directory = join(root, 'production');
  let now = NOTAM_NOW, calls = 0;
  const store = new NotamStore(directory, 'production', () => now);
  const options = { enabled: true, environment: 'production' as const, directory: root, credentials: { clientId: 'fixture', clientSecret: 'fixture' } };
  const dependencies = { signal: new AbortController().signal, now: () => now, wait: async (ms: number) => { now += ms; },
    fetch: (async input => {
      calls++;
      const url = String(input);
      assert.ok(!url.includes('/il') && !url.includes('/content/'), 'replay must not acquire another bulk');
      if (url.endsWith('/v1/auth/token')) return Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' });
      return Response.json({ status: 'Success', data: { aixm: [] } });
    }) as typeof fetch };
  let service: ReturnType<typeof createNotamService> | undefined;
  try {
    await store.restore(); await store.admission.reserve('bulk');
    await store.publish({ schemaVersion: 2, environment: 'production', records: [notice({ text: 'previous',
      updatedAt: now - 120_000, sourceUpdatedAt: new Date(now - 120_000).toISOString() })], complete: true,
      checkedAt: now - 60_000, watermark: now - 60_000, baselineAt: now - 86_400_000, fullSyncAt: now - 86_400_000 });
    const history = new NotamReconciliation(store, () => now); await history.started();
    await history.failed(now, new NotamError('parse-timeout'));
    const path = join(directory, 'download.tmp'); await writeFile(path, gzipSync(bulkXml([notice()])));
    await new NotamBulkSource(store, () => now).save(path, now);
    const budget = await readFile(join(directory, 'budget.json'));
    await store.close(); now += 181_000;
    service = createNotamService(options, dependencies); await service.restore();
    assert.equal(service.reconciliation?.pending, true);
    service.refresh(); await service.settled();
    assert.equal(calls, 0);
    assert.deepEqual(await readFile(join(directory, 'budget.json')), budget);
    assert.equal(service.reconciliation?.pending, true);
    assert.equal(service.reconciliation?.error, 'parse-timeout', 'only a bridged generation resolves the failure');
    assert.equal((await readdir(directory)).some(name => name.startsWith('bulk-source')), false);
    await service.close();
    service = createNotamService(options, dependencies); await service.restore();
    service.refresh(); await service.settled();
    assert.equal(calls, 2);
    assert.equal(service.status.state, 'ready');
    assert.equal(service.status.fullSyncAt, NOTAM_NOW);
    assert.equal(service.reconciliation?.error, null);
    assert.equal(service.readAirport({ faaId: 'TST' })?.records[0]?.text, notice().text);
    const after = JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8'));
    assert.equal(after.bulkAt, JSON.parse(budget.toString()).bulkAt);
  } finally { await service?.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('bulk worker preserves UTF-8 and record boundaries across buffered writes, including oversized records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-bulk-buffer-'));
  try {
    const records = Array.from({ length: 180 }, (_, index) => notice({
      id: String(1757600000000001 + index), sourceId: String(1757600000000001 + index),
      text: index === 90 ? '空'.repeat(30_000) : `Record ${index}: 空港`,
    }));
    const xml = bulkXml(records), expected: string[] = [];
    const parser = createNotamXmlParser(record => expected.push(JSON.stringify(record) + '\n'));
    parser.write(xml); parser.finish();
    for (const compressed of [false, true]) {
      const path = join(directory, 'source'), output = join(directory, `parsed-${compressed}`);
      await writeFile(path, compressed ? gzipSync(xml) : xml);
      const summary = await workerJob<{ count: number; bytes: number }>(new URL('../tools/info-server/notams-worker.ts', import.meta.url),
        { path, output, kind: 'bulk', requestedAt: NOTAM_NOW }, new AbortController().signal);
      assert.equal(summary.count, records.length);
      assert.equal(summary.bytes, Buffer.byteLength(expected.join('')));
      assert.equal(await readFile(output, 'utf8'), expected.join(''));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
