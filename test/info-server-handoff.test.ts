import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInfoServer } from '../tools/info-server/server';
import { createTfrService } from '../tools/info-server/notams/tfr-service';
import { createNotamService } from '../tools/info-server/notams/service';
import { NotamStore } from '../tools/info-server/notams/store';
import { aixm, notice, NOTAM_NOW } from './fixtures/notams';
import corpus from './fixtures/tfrs.json' with { type: 'json' };

const START = Date.parse('2026-10-05T21:00Z');
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

// A real, separate process group includes the flock helpers. Calling app.close()
// alone cannot expose a supervisor that signals those helpers prematurely.
for (const wholeGroup of [false, true]) test(`process shutdown ${wholeGroup ? 'rejects premature lock-holder termination' : 'preserves admitted work with the configured supervisor signal scope'}`,
  { timeout: 15_000, skip: process.platform !== 'linux' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'info-handoff-process-'));
    const unit = await readFile(new URL('../tools/info-server/zlayer-info.service', import.meta.url), 'utf8');
    const mode = /^KillMode=(\S+)$/m.exec(unit)?.[1] ?? 'control-group';
    const script = `
      import { readFile } from 'node:fs/promises';
      import { createInfoServer } from ${JSON.stringify(new URL('../tools/info-server/server.ts', import.meta.url).href)};
      const corpus = JSON.parse(await readFile(new URL(${JSON.stringify(new URL('./fixtures/tfrs.json', import.meta.url).href)}), 'utf8'));
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const app = await createInfoServer({ directory: process.argv[1], startUpdates: false,
        now: () => ${START}, notams: {enabled: true, environment: 'production', directory: process.argv[1], credentials: {clientId: 'fixture', clientSecret: 'fixture'}},
        fetch: async input => {
          if (String(input).endsWith('getTfrList')) return Response.json([corpus.cases[0].index]);
          process.send('admitted'); await gate; return new Response(corpus.cases[0].xml);
        }});
      // Delay owner handling so an incorrectly signaled idle lock holder has
      // exited before its quiescence check, as well as the active TFR writer.
      process.once('SIGTERM', () => setTimeout(() => {
        const closing = app.close();
        setTimeout(release, 150);
        void closing.then(() => process.send({lifecycle: app.lifecycle}), error => {
          process.exitCode = 1;
          process.send({lifecycle: app.lifecycle, errors: error.errors.map(cause => cause.message)});
        }).finally(() => process.disconnect());
      }, 150));
      void app.tfrs.refresh();
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    try {
      assert.equal((await once(child, 'message'))[0], 'admitted');
      const completed = once(child, 'message');
      process.kill(wholeGroup || mode !== 'mixed' ? -child.pid! : child.pid!, 'SIGTERM');
      const [result] = await completed as [{ lifecycle: { phase: string; forced: boolean }; errors?: string[] }];
      const [code, signal] = await exited;
      assert.equal(signal, null, stderr); assert.equal(code, wholeGroup ? 1 : 0, stderr);
      assert.equal(result.lifecycle.phase, wholeGroup ? 'failed' : 'stopped'); assert.equal(result.lifecycle.forced, false);
      const admission = JSON.parse(await readFile(join(directory, 'tfrs/admission.json'), 'utf8'));
      assert.equal(admission.failed, wholeGroup, 'lost ownership must retain the uncertain reservation');
      if (wholeGroup) assert.deepEqual(result.errors, ['writer-lock-lost', 'writer-lock-lost'], 'both FAA owners reject lost locks');
      else {
        const saved = JSON.parse(JSON.parse(await readFile(join(directory, 'tfrs/snapshot.json'), 'utf8')).data);
        assert.equal(saved.notices.length, 1); assert.equal(saved.issues.length, 0);
      }
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await exited; await rm(directory, {recursive: true, force: true});
    }
  });

test('NOTAM quiescence commits its admitted delta and preserves quota while refusing later rounds', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-handoff-')), state = join(directory, 'production');
  let now = NOTAM_NOW;
  const seed = new NotamStore(state, 'production', () => now);
  await seed.restore(); const reservation = await seed.admission.reserve('bulk'); await seed.admission.finishRequest(reservation);
  await seed.publish({ schemaVersion: 2, environment: 'production', records: [], issues: [], complete: true,
    checkedAt: now, watermark: now, baselineAt: now, fullSyncAt: now });
  await seed.close(); now += 180_000;
  const entered = gate<AbortSignal>(), release = gate<void>(); let dataRequests = 0;
  const options = { enabled: true, environment: 'production' as const, directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } };
  const service = createNotamService(options, { signal: new AbortController().signal, now: () => now,
    wait: async ms => { now += ms; }, fetch: async (input, init) => {
      if (String(input).endsWith('/v1/auth/token')) return Response.json({ access_token: 'fixture', token_type: 'BearerToken', expires_in: '1799' });
      dataRequests++; entered.resolve(init!.signal!); await release.promise;
      return Response.json({ status: 'Success', data: { aixm: [aixm(notice())] } });
    } });
  try {
    await service.restore(); service.refresh(); const signal = await entered.promise;
    const quiesced = service.quiesce(); service.refresh(); assert.equal(signal.aborted, false);
    release.resolve(); await quiesced;
    assert.equal(service.status.state, 'ready'); assert.equal(service.status.recordCount, 1);
    assert.equal(service.status.collectionContinuity, 'complete');
    const checkedAt = service.status.checkedAt, budget = await readFile(join(state, 'budget.json'), 'utf8');
    now += 180_000; service.refresh(); await service.settled(); assert.equal(dataRequests, 1);
    await service.close();
    const restored = createNotamService(options, { signal: new AbortController().signal, now: () => now,
      fetch: async () => assert.fail('Restore must not consume source quota') });
    try {
      await restored.restore(); assert.equal(restored.status.checkedAt, checkedAt); assert.equal(restored.status.recordCount, 1);
      assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
    } finally { await restored.close(); }
  } finally { release.resolve(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('TFR quiescence checkpoints an admitted detail, blocks the remaining queue and keeps ownership until close', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-handoff-'));
  const entered = gate<AbortSignal>(), release = gate<void>();
  let now = START, reads = 0;
  const service = createTfrService({ directory, signal: new AbortController().signal, now: () => now,
    wait: async ms => { now += ms; }, fetch: async (input, init) => {
      reads++;
      if (String(input).endsWith('getTfrList')) return Response.json(corpus.cases.slice(0, 2).map(c => c.index));
      entered.resolve(init!.signal!); await release.promise; return new Response(corpus.cases[0]!.xml);
    } });
  try {
    await service.restore(); const round = service.refresh(); const signal = await entered.promise;
    const quiesced = service.quiesce(); void service.refresh();
    assert.equal(signal.aborted, false, 'quiesce does not cancel an admitted response');
    release.resolve(); await quiesced; await round;
    assert.equal(reads, 2, 'index and admitted detail only; remaining work is not admitted');
    assert.equal(service.read()!.notices.length, 1);
    assert.equal(service.read()!.issues?.length, 1, 'unacquired membership remains explicit');
    assert.equal(service.status.error, 'incomplete-details');
    const saved = await readFile(join(directory, 'tfrs/admission.json'), 'utf8');
    assert.equal(JSON.parse(saved).failed, false, 'successful checkpoint is not an interrupted request');
    const contender = createTfrService({ directory, signal: new AbortController().signal, now: () => now });
    await contender.restore(); assert.equal(contender.status.error, 'storage-unavailable'); await contender.close();
    now += 180_000; await service.refresh(); assert.equal(reads, 2, 'passing a schedule deadline cannot reopen admission');
    await service.close();
    const restored = createTfrService({ directory, signal: new AbortController().signal, now: () => now,
      fetch: async () => assert.fail('Restore must not acquire source data') });
    try {
      await restored.restore();
      assert.equal(restored.read()!.notices[0]!.detailCheckedAt, START + 1000);
      assert.equal(restored.read()!.issues?.length, 1);
      assert.equal(await readFile(join(directory, 'tfrs/admission.json'), 'utf8'), saved);
    } finally { await restored.close(); }
  } finally { release.resolve(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('server close atomically closes FAA admission, commits a pending response, then releases listener and writer ownership', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'info-handoff-'));
  const entered = gate<AbortSignal>(), release = gate<void>(); let now = START, reads = 0;
  const app = await createInfoServer({ directory, startUpdates: false, now: () => now,
    fetch: async (input, init) => {
      reads++;
      if (String(input).endsWith('getTfrList')) return Response.json([corpus.cases[0]!.index]);
      entered.resolve(init!.signal!); await release.promise; return new Response(corpus.cases[0]!.xml);
    } });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const round = app.tfrs.refresh(), sourceSignal = await entered.promise;
    const closing = app.close(); assert.equal(app.close(), closing, 'shutdown is idempotent');
    assert.equal(app.lifecycle.phase, 'quiescing'); assert.equal(app.server.listening, false);
    assert.equal(sourceSignal.aborted, false);
    void app.tfrs.refresh(); app.notams.refresh();
    release.resolve(); await closing; await round;
    assert.equal(app.lifecycle.phase, 'stopped'); assert.equal(app.lifecycle.forced, false);
    assert.equal(reads, 2); assert.equal(app.tfrs.status.error, null);
    const saved = await readFile(join(directory, 'tfrs/admission.json'), 'utf8');
    assert.equal(JSON.parse(saved).failed, false);
    now += 180_000; await app.tfrs.refresh(); assert.equal(reads, 2);
    const next = await createInfoServer({ directory, startUpdates: false, now: () => now,
      fetch: async () => assert.fail('Handoff restore must not acquire source data') });
    try {
      assert.equal(next.tfrs.status.error, null); assert.equal(next.tfrs.read()!.notices.length, 1);
      assert.equal(await readFile(join(directory, 'tfrs/admission.json'), 'utf8'), saved);
    } finally { await next.close(); }
  } finally { release.resolve(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a shutdown deadline aborts a hung request, reports failure and preserves its conservative admission across restart', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'info-handoff-timeout-'));
  const entered = gate<AbortSignal>();
  const app = await createInfoServer({ directory, startUpdates: false, now: () => START, shutdownGraceMs: 20,
    fetch: async (_input, init) => {
      const signal = init!.signal!; entered.resolve(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
  try {
    const round = app.tfrs.refresh(), signal = await entered.promise;
    const admitted = await readFile(join(directory, 'tfrs/admission.json'), 'utf8');
    await assert.rejects(app.close(), AggregateError); await round;
    assert.equal(signal.aborted, true); assert.equal(app.lifecycle.phase, 'failed'); assert.equal(app.lifecycle.forced, true);
    assert.equal(await readFile(join(directory, 'tfrs/admission.json'), 'utf8'), admitted);
    const next = await createInfoServer({ directory, startUpdates: false, now: () => START,
      fetch: async () => assert.fail('Interrupted admission cannot grant a new attempt') });
    try {
      assert.equal(next.tfrs.status.error, 'refresh-failed'); assert.ok(next.tfrs.status.nextAttemptAt! > START);
      await next.tfrs.refresh();
      assert.equal(await readFile(join(directory, 'tfrs/admission.json'), 'utf8'), admitted);
    } finally { await next.close(); }
  } finally { await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
