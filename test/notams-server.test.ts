import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createNotamXmlParser } from '../tools/info-server/notams/normalize';
import { notamTime } from '../src/layers/notams/validity';
import { NotamStore, NOTAM_DAY_MS, type NotamGeneration } from '../tools/info-server/notams/store';
import { createNotamService, mergeNotamRecords } from '../tools/info-server/notams/service';
import { NotamRevisionConflict } from '../tools/info-server/notams/revision';
import { notamResponse } from '../tools/info-server/notams/routes';
import { createInfoServer } from '../tools/info-server/server';
import { aixm, bulkXml, notice, NOTAM_NOW } from './fixtures/notams';
import type { NotamRecord } from '@zlayer/contracts';

function normalized(record: NotamRecord, xml = aixm(record)) {
  const records: NotamRecord[] = [], parser = createNotamXmlParser(r => records.push(r), { count: 1, snapshotAt: NOTAM_NOW });
  parser.write(xml); parser.finish(); return records[0]!;
}
function generation(records: readonly NotamRecord[], time = NOTAM_NOW): Omit<NotamGeneration, 'generation'> {
  return { schemaVersion: 1, environment: 'staging', records, complete: true,
    checkedAt: time, watermark: time, fullSyncAt: time, baselineAt: time };
}
function representationPair() {
  const icao = { type: 'OTHER:ICAO', text: 'A0042/26 NOTAMN A) KTST B) 2610041159 C) 2610051200 E) RWY 09L CLSD' };
  const previous = normalized(notice({ number: '0042', text: 'RWY 09L CLSD',
    translations: [{ type: 'LOCAL_FORMAT', text: '!TST 10/042 TST RWY 09L CLSD 2610041159-2610051200' }, icao] }));
  const next = normalized(notice({ number: '42', text: previous.text,
    translations: [{ ...icao, text: `<pre>\n${icao.text.replaceAll(' ', '\n')}\n</pre>` }] }));
  return { previous, next };
}

test('bounded AIXM parser uses namespaces, rejects truncated counts and retains source facts', () => {
  const records: NotamRecord[] = [], xml = bulkXml([notice()]);
  const parser = createNotamXmlParser(record => records.push(record));
  for (let i = 0; i < xml.length; i += 29) parser.write(xml.slice(i, i + 29));
  assert.deepEqual(parser.finish(), { count: 1, snapshotAt: NOTAM_NOW });
  assert.equal(records[0]?.id, '1757600000000001'); assert.equal(records[0]?.text, notice().text);
  assert.equal(records[0]?.translations[0]?.text, notice().translations[0]?.text);
  for (const bad of [bulkXml([notice()], NOTAM_NOW, 2), xml.slice(0, -20),
    xml.replace('http://www.aixm.aero/schema/5.1/message', 'urn:wrong'),
    xml.replace('<?xml version="1.0"?>', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>')]) {
    assert.throws(() => { const parser = createNotamXmlParser(() => {}); parser.write(bad); parser.finish(); });
  }
  const fragment = createNotamXmlParser(() => {}, { count: 1, snapshotAt: NOTAM_NOW });
  fragment.write('<?xml version="1.0"?>' + aixm()); assert.equal(fragment.finish().count, 1);
  assert.equal(notamTime('202602300100'), null); assert.equal(notamTime('202610041200EST'), NOTAM_NOW);
  assert.equal(notamTime('PERM'), null);
});
test('revision ordering rejects conflicts and unsupported lifecycle without advancing state', () => {
  const previous = notice(), newer = notice({ updatedAt: NOTAM_NOW, revision: 'b'.repeat(64) });
  assert.equal(mergeNotamRecords([newer], [previous])[0], newer);
  assert.throws(() => mergeNotamRecords([previous], [{ ...previous, text: 'RWY 09L CLSD', revision: newer.revision }]), /revision-conflict/);
  assert.throws(() => mergeNotamRecords([previous], [notice({ lifecycle: 'unknown', changeType: 'UNSUPPORTED' })]), /unsupported-lifecycle/);
  assert.equal(mergeNotamRecords([previous], [{ ...newer, lifecycle: 'cancelled' }])[0]?.lifecycle, 'cancelled');
});
test('equivalent source IDs and timestamp spellings do not conflict or replace retained raw records', () => {
  const old = normalized(notice()), previous = [old];
  for (const overrides of [
    { sourceId: old.id },
    { sourceUpdatedAt: old.sourceUpdatedAt.replace('.000Z', 'Z') },
    { sourceUpdatedAt: old.sourceUpdatedAt.replace('.000Z', '.000000000Z') },
  ]) {
    const record = notice(overrides);
    const next = normalized(record, aixm(record).replace(/<f:lastUpdated>[^<]+/, `<f:lastUpdated>${record.sourceUpdatedAt}`));
    assert.notEqual(old.revision, next.revision);
    assert.equal(mergeNotamRecords(previous, [next]), previous);
    assert.equal(mergeNotamRecords([next], previous)[0], next);
  }
  const nano = normalized(notice(), aixm().replace('.000Z</f:lastUpdated>', '.000000001Z</f:lastUpdated>'));
  assert.equal(mergeNotamRecords(previous, [nano])[0], nano);
  assert.equal(mergeNotamRecords([nano], previous)[0], nano);
  const conflict = normalized(notice({ sourceId: old.id, text: 'RWY 09L CLSD' }));
  assert.throws(() => mergeNotamRecords(previous, [conflict]), error => error instanceof NotamRevisionConflict &&
    error.fields.length === 1 && error.fields[0] === 'text' && error.previous === old && error.next === conflict);
});
test('same-revision padding and optional translation formats retain source text in either arrival order', () => {
  const { previous, next } = representationPair(), saved = [previous];
  assert.notEqual(previous.revision, next.revision);
  assert.equal(mergeNotamRecords(saved, [next]), saved, 'a sparse rendering cannot erase the local translation');
  const enriched = mergeNotamRecords([next], [previous]);
  assert.equal(enriched[0]?.number, next.number, 'retain the first raw numeric spelling');
  assert.deepEqual(enriched[0]?.translations, [...next.translations, previous.translations[0]]);
  assert.notEqual(enriched[0]?.revision, next.revision, 'the digest must include added raw content');
  assert.equal(mergeNotamRecords(enriched, [previous, next]), enriched, 'replay is idempotent');
  const reordered = normalized(notice({ ...previous, translations: [...previous.translations].reverse() }));
  assert.equal(mergeNotamRecords(saved, [reordered]), saved);
  const corrected = normalized(notice({ ...next, updatedAt: NOTAM_NOW, text: 'RWY 09R CLSD' }));
  assert.equal(mergeNotamRecords(saved, [corrected])[0], corrected, 'never carry translations into a newer revision');
});
test('representation tolerance still rejects changed notice content and bounds combined translations', () => {
  const { previous, next } = representationPair();
  for (const overrides of [
    { number: '43' }, { number: '00/42' }, { text: 'RWY 09R CLSD' },
    { effectiveEnd: '202610051300' }, { lifecycle: 'cancelled' as const },
    { translations: [{ ...next.translations[0]!, text: next.translations[0]!.text.replace('09L', '09R') }] },
    { translations: [{ type: 'OTHER:ICAO', text: '<div>different wording</div>' }] },
  ]) assert.throws(() => mergeNotamRecords([previous], [normalized(notice({ ...next, ...overrides }))]), NotamRevisionConflict);
  const many = (start: number) => normalized(notice({ translations: Array.from({ length: 5 }, (_, i) => ({ type: `OTHER:${i + start}`, text: 'Raw source' })) }));
  assert.throws(() => mergeNotamRecords([many(0)], [many(5)]), /invalid-record/);
});
test('observed FAA timestamp, translation, annotation and lifecycle variants normalize without losing meaning', () => {
  const base = aixm(notice({ text: 'IAP TEST.\nRNAV (GPS) RWY 9, AMDT 2...\n2610041159-2610051200EST' }));
  const source = base.replaceAll('2026-10-04T11:59:00.000Z', '2026-10-04T11:59:00.123456789Z')
    .replace('<e:type>N</e:type>', '')
    .replace(/<e:simpleText>([\s\S]*?)<\/e:simpleText>/, '<e:formattedText><h:div xmlns:h="http://www.w3.org/1999/xhtml">FIRST<h:br/>SECOND &amp; THIRD</h:div></e:formattedText>')
    .replace('<e:Event>', '<e:Event><e:timeSlice><e:EventTimeSlice><e:encoding>ANNOTATION</e:encoding></e:EventTimeSlice></e:timeSlice>');
  const records: NotamRecord[] = [], parser = createNotamXmlParser(r => records.push(r), { count: 1, snapshotAt: NOTAM_NOW });
  parser.write(source); parser.finish();
  assert.equal(records[0]?.translations[0]?.text, 'FIRST\nSECOND & THIRD');
  assert.equal(records[0]?.sourceUpdatedAt, '2026-10-04T11:59:00.123456789Z');
  assert.equal(records[0]?.lifecycle, 'active'); assert.equal(records[0]?.endKind, 'estimated');
  for (const [changeType, lifecycle] of [['C', 'cancellation'], ['N', 'cancelled']] as const) {
    const parser = createNotamXmlParser(r => assert.equal(r.lifecycle, lifecycle), { count: 1, snapshotAt: NOTAM_NOW });
    parser.write(aixm(notice({ changeType, lifecycle: lifecycle === 'cancelled' ? lifecycle : 'active' }))); parser.finish();
  }
  assert.equal(notamTime('000101010000'), null);
  const a = notice({ sourceUpdatedAt: '2026-10-04T11:59:00.000000001Z' }), b = notice({ sourceUpdatedAt: '2026-10-04T11:59:00.000000002Z', revision: 'b'.repeat(64) });
  assert.equal(mergeNotamRecords([b], [a])[0], b, 'sub-millisecond revisions cannot regress');
});
test('durable quota is shared by failed attempts, lock owners, restart and clock rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-budget-')); let time = NOTAM_NOW;
  const first = new NotamStore(directory, 'staging', () => time), second = new NotamStore(directory, 'staging', () => time);
  try {
    await first.restore(); await first.reserve('bulk');
    await assert.rejects(second.restore(), /writer-already-active/);
    await first.close(); await second.close();
    const next = new NotamStore(directory, 'staging', () => time);
    try {
      await next.restore(); assert.equal(next.nextBulkAt, NOTAM_NOW + NOTAM_DAY_MS);
      await assert.rejects(next.reserve('bulk'), /request-budget/);
      time += 180_000; await next.reserve('delta');
      time = NOTAM_NOW - 1; await assert.rejects(next.reserve('auth'), /request-budget/);
    } finally { await next.close(); }
    await rm(join(directory, 'budget.json'));
    const damaged = new NotamStore(directory, 'staging', () => time);
    try { await assert.rejects(damaged.restore()); } finally { await damaged.close(); }
  } finally { await first.close(); await second.close(); await rm(directory, { recursive: true, force: true }); }
});
test('checksummed snapshots recover the previous generation without resetting quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-checkpoint-'));
  const store = new NotamStore(directory, 'staging', () => NOTAM_NOW);
  try {
    await store.restore(); await store.reserve('bulk');
    const value = { schemaVersion: 1 as const, environment: 'staging' as const, records: [notice()], complete: true,
      checkedAt: NOTAM_NOW, watermark: NOTAM_NOW, fullSyncAt: NOTAM_NOW, baselineAt: NOTAM_NOW };
    const first = await store.publish(value);
    const second = await store.publish({ ...value, records: [notice({ revision: 'b'.repeat(64), text: 'RWY 09L CLSD' })] });
    await store.close(); await writeFile(join(directory, `${second.generation}.ndjson`), 'broken');
    const restored = new NotamStore(directory, 'staging', () => NOTAM_NOW);
    try {
      const result = await restored.restore(); assert.equal(result?.generation, first.generation); assert.equal(result?.complete, false);
      assert.equal(restored.nextBulkAt, NOTAM_NOW + NOTAM_DAY_MS);
    } finally { await restored.close(); }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
test('unchanged deltas advance freshness without rewriting data or replacing distinct history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-unchanged-'));
  const store = new NotamStore(directory, 'staging', () => NOTAM_NOW + 180_000);
  try {
    await store.restore();
    const previous = await store.publish(generation([notice()]));
    const current = await store.publish(generation([notice({ revision: 'b'.repeat(64), updatedAt: NOTAM_NOW })]));
    const path = join(directory, `${current.generation}.ndjson`), before = await stat(path);
    for (const updates of [[], [current.records[0]!], [notice()]]) {
      const records = mergeNotamRecords(current.records, updates);
      assert.equal(records, current.records);
      const result = await store.publish({ ...current, records, checkedAt: NOTAM_NOW + 180_000, watermark: NOTAM_NOW + 180_000 });
      assert.equal(result.generation, current.generation);
    }
    const after = await stat(path);
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')).checkedAt, NOTAM_NOW + 180_000);
    assert.equal(JSON.parse(await readFile(join(directory, 'previous.json'), 'utf8')).generation, previous.generation);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
test('only current, previous and candidate manifests retain datasets across replacement and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-prune-'));
  const store = new NotamStore(directory, 'staging', () => NOTAM_NOW);
  const restored = new NotamStore(directory, 'staging', () => NOTAM_NOW);
  try {
    await store.restore(); await store.reserve('bulk');
    const journal = await readFile(join(directory, 'budget.json'), 'utf8');
    const first = await store.publish(generation([notice()]));
    const second = await store.publish(generation([notice({ text: 'RWY 09L CLSD' })]));
    let candidate: NotamGeneration | undefined;
    for (let i = 0; i < 5; i++) {
      candidate = await store.publish({ ...generation([notice({ text: `IAP TEST ${i}` })]), complete: false }, true);
      assert.equal((await readdir(directory)).filter(name => name.endsWith('.ndjson')).length, 3);
    }
    const orphan = join(directory, `${'f'.repeat(64)}.ndjson`);
    await writeFile(orphan, 'interrupted write'); await store.close();
    assert.equal((await restored.restore())?.generation, second.generation);
    assert.equal((await restored.restoreCandidate())?.generation, candidate?.generation);
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.ndjson')).length, 3);
    await restored.discardCandidate();
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.ndjson')).sort(), [first, second].map(g => `${g.generation}.ndjson`).sort());
    assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), journal);
  } finally { await store.close(); await restored.close(); await rm(directory, { recursive: true, force: true }); }
});
test('verified saved end-kind upgrades reconcile with source revisions without resetting quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-upgrade-'));
  const store = new NotamStore(directory, 'staging', () => NOTAM_NOW);
  const restored = new NotamStore(directory, 'staging', () => NOTAM_NOW);
  try {
    const current = normalized(notice({ translations: [{ type: 'LOCAL_FORMAT', text: 'RWY 09L CLSD 2610041159-2610051200EST\nEND PART 1 OF 2' }] }));
    assert.equal(current.endKind, 'estimated');
    const { revision: _revision, ...facts } = { ...current, endKind: 'fixed' as const };
    const old = { ...facts, revision: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
    await store.restore(); await store.reserve('bulk');
    const journal = await readFile(join(directory, 'budget.json'), 'utf8');
    const saved = await store.publish(generation([old])); await store.close();
    const result = await restored.restore();
    assert.equal(result?.records[0]?.endKind, 'estimated');
    assert.equal(result?.records[0]?.revision, current.revision);
    assert.notEqual(result?.generation, saved.generation);
    assert.equal(result?.watermark, NOTAM_NOW); assert.equal(result?.complete, true);
    assert.equal(mergeNotamRecords(result!.records, [current]), result!.records);
    assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), journal);
    await restored.restoreCandidate();
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.ndjson')).length, 1);
  } finally { await store.close(); await restored.close(); await rm(directory, { recursive: true, force: true }); }
});
test('bulk bridge, deltas and local airport reads share one collector; failures retain the published generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-service-')), controller = new AbortController();
  let time = NOTAM_NOW, updates: NotamRecord[] = [], invalid = false;
  const calls: string[] = [];
  const service = createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, signal: controller.signal, fetch: async input => {
      const url = new URL(String(input)); calls.push(url.pathname); time += 1001;
      if (url.pathname === '/v1/auth/token') return Response.json({ access_token: 'fixture-bearer', expires_in: '1799', token_type: 'BearerToken' });
      if (url.pathname.endsWith('/il')) return Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } });
      if (url.pathname.endsWith('/content/fixture')) return new Response(gzipSync(bulkXml([notice()])));
      return Response.json(invalid ? { status: 'Success', errors: ['source-error'], data: { aixm: [] } }
        : { status: 'Success', data: { aixm: updates.map(aixm) } });
    } });
  try {
    await service.restore(); assert.equal(calls.length, 0);
    service.refresh(); service.refresh(); await service.settled(); assert.equal(calls.length, 3);
    assert.equal(service.readAirport({ faaId: 'TST' }), undefined, 'bulk is a candidate until bridged');
    time += 180_000; service.refresh(); await service.settled(); assert.equal(service.status.state, 'ready');
    const generation = service.status.generation;
    for (let i = 0; i < 100; i++) assert.equal(notamResponse('/api/notams/airports?faaId=tst&icaoId=KTST', undefined, service).status, 200);
    assert.equal(calls.length, 4, 'airport reads never spend quota');
    assert.equal(service.readAirport({ faaId: 'TST', icaoId: 'KTST' })?.records.length, 1, 'alias union deduplicates');
    assert.equal(service.readAirport({ faaId: 'ZZZ' })?.records.length, 0, 'accountability is not airport location');
    assert.equal(service.readAirport({ icaoId: 'KTST' })?.associationCoverage, 'incomplete');
    for (const query of ['id=KTST', 'faaId=TST&faaId=TST', 'faaId=', 'faaId=TST&url=x']) {
      assert.equal(notamResponse(`/api/notams/airports?${query}`, undefined, service).status, 400);
    }
    time += 180_000; invalid = true; service.refresh(); await service.settled();
    assert.equal(service.status.state, 'degraded'); assert.equal(service.status.generation, generation);
    time += 180_001; invalid = false; updates = [notice({ updatedAt: time - 1, lifecycle: 'cancelled' })];
    service.refresh(); await service.settled(); assert.equal(service.readAirport({ faaId: 'TST' })?.records.length, 0);
    const journal = JSON.parse(await readFile(join(directory, 'staging', 'budget.json'), 'utf8'));
    assert.ok(journal.bulkAt >= NOTAM_NOW + NOTAM_DAY_MS);
  } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
for (const failure of ['bulk-lifecycle', 'bridge-conflict', 'bridge-transport'] as const) {
  test(`failed replacement ${failure} preserves live continuity and resumes budgeted deltas`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notam-replacement-')), controller = new AbortController();
    let time = NOTAM_NOW - NOTAM_DAY_MS, fail = true, deltas = 0;
    const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
    await seed.restore(); await seed.reserve('bulk'); time = NOTAM_NOW;
    const original = await seed.publish(generation([normalized(notice())], time - 180_000)); await seed.close();
    const service = createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
      { now: () => time, signal: controller.signal, fetch: async input => {
        const url = new URL(String(input)); time += 1001;
        if (url.pathname === '/v1/auth/token') return Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' });
        if (url.pathname.endsWith('/il')) return Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } });
        if (url.pathname.endsWith('/content/fixture')) return new Response(gzipSync(bulkXml([
          notice(failure === 'bulk-lifecycle' ? { changeType: 'UNSUPPORTED' } : { text: 'RWY 09L CLSD' }),
        ], time)));
        deltas++;
        if (fail && failure === 'bridge-transport') return new Response('', { status: 503 });
        return Response.json({ status: 'Success', data: { aixm: fail && failure === 'bridge-conflict' ? [aixm(notice())] : [] } });
      } });
    try {
      await service.restore(); service.refresh(); await service.settled();
      if (failure !== 'bulk-lifecycle') {
        time += 180_000; service.refresh(); await service.settled();
      }
      assert.equal(service.status.state, 'degraded');
      assert.equal(service.status.generation, original.generation);
      assert.equal(service.status.continuity, 'complete');
      assert.equal(JSON.parse(await readFile(join(directory, 'staging', 'current.json'), 'utf8')).complete, true);
      assert.equal((await readdir(join(directory, 'staging'))).includes('candidate.json'), false);
      assert.equal((await readdir(join(directory, 'staging'))).filter(name => name.endsWith('.ndjson')).length, 1);
      const attempts = deltas;
      fail = false; service.refresh(); await service.settled(); assert.equal(deltas, attempts, 'failure backoff remains enforced');
      time += 180_000; service.refresh(); await service.settled();
      assert.equal(deltas, attempts + 1); assert.equal(service.status.state, 'ready');
      assert.equal(service.status.generation, original.generation);
      assert.ok(service.status.watermark! > original.watermark);
    } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
test('a live conflict preserves diagnostics and its cause across restart, then recovers by verified replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-live-failure-')), controller = new AbortController();
  let time = NOTAM_NOW, conflict = true;
  const requests: string[] = [], logs: string[] = [];
  const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
  await seed.restore(); await seed.reserve('bulk'); await seed.publish(generation([normalized(notice())])); await seed.close();
  time += 180_000;
  const create = () => createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, signal: controller.signal, log: value => logs.push(value), fetch: async input => {
      requests.push(String(input));
      time += 1001;
      return new URL(String(input)).pathname === '/v1/auth/token'
        ? Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' })
        : Response.json({ status: 'Success', data: { aixm: [aixm(notice(conflict ? { text: 'Conflicting source revision' }
          : { updatedAt: time - 1000, text: 'Resolved source revision' }))] } });
    } });
  let service = create();
  try {
    await service.restore(); service.refresh(); await service.settled();
    assert.equal(service.status.error, 'revision-conflict'); assert.equal(service.status.continuity, 'incomplete');
    const manifest = JSON.parse(await readFile(join(directory, 'staging', 'current.json'), 'utf8'));
    assert.equal(manifest.complete, false); assert.equal(manifest.incompleteReason, 'revision-conflict');
    assert.equal(manifest.watermark, NOTAM_NOW);
    const diagnosticPath = join(directory, 'staging', 'conflict.json');
    const diagnostic = JSON.parse(await readFile(diagnosticPath, 'utf8'));
    assert.equal(diagnostic.id, notice().id); assert.deepEqual(diagnostic.fields, ['text']);
    assert.equal(diagnostic.previous.text, notice().text); assert.equal(diagnostic.next.text, 'Conflicting source revision');
    assert.equal((await stat(diagnosticPath)).mode & 0o777, 0o600);
    assert.ok(logs.some(log => log.includes(`id=${notice().id} fields=text`)));
    assert.ok(logs.every(log => !log.includes('Conflicting source revision')));
    const budget = await readFile(join(directory, 'staging', 'budget.json'), 'utf8');
    await service.close(); service = create(); await service.restore();
    assert.equal(service.status.error, 'revision-conflict');
    assert.equal(await readFile(join(directory, 'staging', 'budget.json'), 'utf8'), budget);
    const before = requests.length; service.refresh(); await service.settled(); assert.equal(requests.length, before);
    time += 180_000; service.refresh(); await service.settled();
    assert.equal(service.status.error, 'revision-conflict'); assert.equal(service.status.watermark, NOTAM_NOW);
    assert.ok(requests.every(url => !url.includes('/il')));
    const replay = new URL(requests.at(-1)!);
    assert.equal(Date.parse(replay.searchParams.get('lastUpdatedDate')!), NOTAM_NOW - 600_000);
    conflict = false; time += 180_000; service.refresh(); await service.settled();
    assert.equal(service.status.state, 'ready'); assert.equal(service.status.continuity, 'complete'); assert.equal(service.status.error, null);
    assert.equal(service.readAirport({ faaId: 'TST' })?.records[0]?.text, 'Resolved source revision');
    assert.equal(JSON.parse(await readFile(join(directory, 'staging', 'budget.json'), 'utf8')).bulkAt, JSON.parse(budget).bulkAt);
  } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('legacy incomplete checkpoints recover from an older verified generation without resetting the bulk allowance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-legacy-replay-')), controller = new AbortController();
  let time = NOTAM_NOW;
  const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
  const old = normalized(notice()), added = normalized(notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002' }));
  await seed.restore(); await seed.reserve('bulk'); await seed.publish(generation([old], time - 180_000));
  await seed.publish(generation([old, added])); await seed.close();
  const path = join(directory, 'staging', 'current.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...manifest, complete: false }));
  const budget = JSON.parse(await readFile(join(directory, 'staging', 'budget.json'), 'utf8'));
  time += 180_000;
  const calls: URL[] = [];
  const service = createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, signal: controller.signal, fetch: async input => {
      const url = new URL(String(input)); calls.push(url); time += 1001;
      return url.pathname === '/v1/auth/token'
        ? Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' })
        : Response.json({ status: 'Success', data: { aixm: [aixm({ ...old, sourceId: old.id }), aixm(added)] } });
    } });
  try {
    await service.restore(); assert.equal(service.status.error, 'incomplete-checkpoint');
    service.refresh(); await service.settled();
    assert.equal(service.status.state, 'ready'); assert.equal(service.status.recordCount, 2);
    assert.ok(service.status.watermark! > manifest.watermark);
    assert.equal(calls.length, 2); assert.equal(Date.parse(calls[1]!.searchParams.get('lastUpdatedDate')!), NOTAM_NOW - 780_000);
    assert.equal(JSON.parse(await readFile(join(directory, 'staging', 'budget.json'), 'utf8')).bulkAt, budget.bulkAt);
  } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a saved representation conflict recovers by full replay and stays healthy on the next delta', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-representation-replay-')), controller = new AbortController();
  let time = NOTAM_NOW;
  const { previous, next } = representationPair();
  const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
  await seed.restore(); await seed.reserve('bulk'); await seed.publish(generation([previous]));
  await seed.invalidate('revision-conflict'); await seed.close();
  const budgetPath = join(directory, 'staging', 'budget.json'), budget = JSON.parse(await readFile(budgetPath, 'utf8'));
  time += 3 * 60 * 60_000;
  const calls: URL[] = [];
  const service = createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, signal: controller.signal, fetch: async input => {
      const url = new URL(String(input)); calls.push(url); time += 1001;
      return url.pathname === '/v1/auth/token'
        ? Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' })
        : Response.json({ status: 'Success', data: { aixm: [aixm(next)] } });
    } });
  try {
    await service.restore(); assert.equal(service.status.error, 'revision-conflict');
    service.refresh(); await service.settled();
    assert.equal(service.status.state, 'ready'); assert.equal(service.status.continuity, 'complete'); assert.equal(service.status.error, null);
    assert.equal(calls.length, 2); assert.equal(Date.parse(calls[1]!.searchParams.get('lastUpdatedDate')!), NOTAM_NOW - 600_000);
    assert.deepEqual(service.readAirport({ faaId: 'TST' })?.records, [previous]);
    const checkedAt = service.status.checkedAt!;
    time += 180_000; service.refresh(); await service.settled();
    assert.equal(service.status.state, 'ready'); assert.ok(service.status.checkedAt! > checkedAt);
    assert.equal(calls.length, 3); assert.equal(JSON.parse(await readFile(budgetPath, 'utf8')).bulkAt, budget.bulkAt);
    assert.ok(calls.every(url => !url.pathname.endsWith('/il')));
  } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unrecoverable continuity keeps its original cause while waiting for the durable bulk allowance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-expired-replay-')), controller = new AbortController();
  let time = NOTAM_NOW;
  const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
  await seed.restore(); await seed.reserve('bulk');
  await seed.publish(generation([normalized(notice())], time - NOTAM_DAY_MS));
  await seed.invalidate('revision-conflict'); await seed.close();
  time += 180_001;
  let requests = 0;
  const service = createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, signal: controller.signal, fetch: async () => { requests++; throw new Error('Unexpected source request'); } });
  try {
    await service.restore(); service.refresh(); await service.settled();
    assert.equal(requests, 0); assert.equal(service.status.error, 'revision-conflict');
    assert.equal(service.status.nextAttemptAt, NOTAM_NOW + NOTAM_DAY_MS);
    time += 180_000; service.refresh(); await service.settled();
    assert.equal(requests, 0); assert.equal(service.status.error, 'revision-conflict');
  } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
test('disabled or misconfigured NOTAMs leave weather HTTP working; GET/HEAD and health are local', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-http-')); let calls = 0;
  const app = await createInfoServer({ directory, startUpdates: false, spacing: 0,
    notams: { enabled: true, directory: join(directory, 'nms'), configurationError: true },
    fetch: async () => { calls++; return Response.json({ type: 'FeatureCollection', features: [] }); } });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const health = await (await fetch(origin + '/api/notams/healthz')).json(); assert.equal(health.error, 'configuration-error');
    assert.equal((await fetch(origin + '/api/notams/airports?faaId=TST')).status, 503);
    const head = await fetch(origin + '/api/notams/healthz', { method: 'HEAD' }); assert.equal(await head.text(), '');
    assert.equal(calls, 0);
    assert.equal((await fetch(origin + '/api/weather/metars.geojson?ids=KTST')).status, 200); assert.equal(calls, 1);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
