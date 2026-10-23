import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { NOTAM_REFRESH_MS, TFR_REFRESH_MS } from '@zlayer/contracts';
import { createNotamService } from '../tools/info-server/notams/service';
import { createTfrService } from '../tools/info-server/notams/tfr-service';
import { NotamStore } from '../tools/info-server/notams/store';
import { NOTAM_NOW } from './fixtures/notams';

for (const family of ['notams', 'tfrs'] as const) {
  test(`${family} retries failed ownership once, preserves durable allowance, and stops retrying on close`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'collector-recovery-'));
    let now = NOTAM_NOW, calls = 0;
    const signal = new AbortController().signal;
    const fetcher = async () => { calls++; throw new Error('No source calls during recovery'); };
    const create = () => family === 'notams'
      ? createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, { signal, now: () => now, fetch: fetcher })
      : createTfrService({ directory, signal, now: () => now, fetch: fetcher });
    const path = join(directory, family === 'notams' ? 'staging/budget.json' : 'tfrs/admission.json');
    const seed = create(); await seed.restore();
    // A conservative, checksummed deadline is already spent. Recovery must not
    // provision new allowance even when no collection has been published.
    const value = JSON.parse(await readFile(path, 'utf8')); delete value.sha256;
    if (family === 'notams') Object.assign(value, { dataAt: now + 600_000, bulkAt: now + 86_400_000 });
    else value.nextAt = now + 600_000;
    const budget = JSON.stringify({ ...value, sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
    await writeFile(path, budget);
    const service = create();
    t.after(async () => { await seed.close(); await service.close(); await rm(directory, { recursive: true, force: true }); });
    await Promise.all([service.restore(), service.restore()]);
    assert.ok(service.status.error); assert.ok(service.status.nextAttemptAt! > now);
    await seed.close();
    for (let i = 0; i < 5; i++) await service.refresh();
    if ('settled' in service) await service.settled();
    assert.ok(service.status.error, 'bounded retry waits after transient failure');
    now += family === 'notams' ? NOTAM_REFRESH_MS : TFR_REFRESH_MS;
    await Promise.all([service.refresh(), service.restore(), service.restore()]);
    if ('settled' in service) await service.settled();
    assert.equal(service.status.error, null);
    assert.equal(await readFile(path, 'utf8'), budget);
    await service.refresh(); if ('settled' in service) await service.settled();
    assert.equal(calls, 0, 'recovery cannot bypass the spent journal');
    await service.close(); now += 2 * 86_400_000;
    await service.restore(); await service.refresh();
    assert.equal(calls, 0, 'shutdown cannot start recovery or acquisition');
  });

  test(`${family} retries repaired storage but never replaces a missing or corrupt admission journal`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'collector-storage-'));
    let now = NOTAM_NOW, calls = 0;
    const signal = new AbortController().signal;
    const fetcher = async () => { calls++; throw new Error('No source calls before valid admission'); };
    const create = () => family === 'notams'
      ? createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, { signal, now: () => now, fetch: fetcher })
      : createTfrService({ directory, signal, now: () => now, fetch: fetcher });
    const path = join(directory, family === 'notams' ? 'staging/budget.json' : 'tfrs/admission.json');
    const seed = create(); await seed.restore(); await seed.close();
    const original = await readFile(path);
    const service = create();
    t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
    await writeFile(path, '{broken'); await service.restore();
    for (let i = 0; i < 3; i++) {
      now += 600_000; await service.refresh(); if ('settled' in service) await service.settled();
      assert.ok(service.status.error); assert.equal(await readFile(path, 'utf8'), '{broken');
    }
    await rm(path); now += 600_000; await service.restore();
    await assert.rejects(readFile(path), { code: 'ENOENT' }); assert.ok(service.status.error);
    await writeFile(path, original); now += 600_000;
    await Promise.all([service.restore(), service.restore()]);
    assert.equal(service.status.error, null); assert.equal(calls, 0);
    assert.deepEqual(await readFile(path), original);
  });

  test(`${family} recovers an uncertain runtime admission write through disk revalidation`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'collector-write-'));
    let now = NOTAM_NOW, calls = 0;
    const signal = new AbortController().signal;
    const fetcher = async () => { calls++; return Response.json([]); };
    const service = family === 'notams'
      ? createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, { signal, now: () => now, fetch: fetcher })
      : createTfrService({ directory, signal, now: () => now, fetch: fetcher });
    t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
    await service.restore();
    const path = join(directory, family === 'notams' ? 'staging/budget.json' : 'tfrs/admission.json');
    const original = await readFile(path);
    await rm(path); await mkdir(path);
    await service.refresh(); if ('settled' in service) await service.settled();
    assert.ok(service.status.error); assert.equal(calls, 0);
    await rm(path, { recursive: true }); await writeFile(path, original);
    now += 600_000; await service.refresh(); if ('settled' in service) await service.settled();
    assert.equal(service.status.error, null); assert.equal(calls, 0);
    assert.deepEqual(await readFile(path), original);
  });
}

test('closing while NOTAM initialization is pending releases ownership without allowing a source request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'collector-close-'));
  const service = createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { signal: new AbortController().signal, now: () => NOTAM_NOW, fetch: async () => { assert.fail('closed collector dispatched'); } });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const restoring = service.restore(); await service.close(); await restoring;
  const owner = new NotamStore(join(directory, 'staging'), 'staging', () => NOTAM_NOW);
  await owner.restore(); await owner.close();
});
