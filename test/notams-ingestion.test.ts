import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { isNotamAirportSnapshot, type NotamRecord } from '@zlayer/contracts';
import { createNotamXmlParser, type NotamMemberRejection } from '../tools/info-server/notams/normalize';
import { pendingNotamMembers } from '../tools/info-server/notams/ingestion';
import { NOTAM_DAY_MS, NotamStore } from '../tools/info-server/notams/store';
import { createNotamService } from '../tools/info-server/notams/service';
import { readArchivedNotamBulk } from '../tools/info-server/notams/bulk-source';
import { replayNotamBulk } from '../tools/replay-notam-bulk';
import { aixm, bulkXml, notice, NOTAM_NOW } from './fixtures/notams';

const parse = (xml: string) => {
  const records: NotamRecord[] = [], parser = createNotamXmlParser(record => records.push(record));
  parser.write(xml); parser.finish(); return records;
};
const base = () => parse(bulkXml([notice()]))[0]!;
const conflictingText = (xml: string) => xml.replace('</e:text>', '</e:text><e:text>RWY 09L OPEN</e:text>');

test('XML singleton fields reject ambiguity independently of element order and retain identical duplicates', () => {
  const xml = bulkXml([notice()]);
  for (const field of ['e:text', 'e:location', 'e:effectiveEnd', 'e:number', 'e:type', 'f:lastUpdated', 'a:sequenceNumber', 'e:simpleText']) {
    const expression = new RegExp(`<${field}>([^<]*)</${field}>`), original = expression.exec(xml)![0];
    const other = `<${field}>DIFFERENT</${field}>`;
    for (const pair of [original + other, other + original]) assert.throws(() => parse(xml.replace(original, pair)), /conflicting-member-field/, field);
    assert.deepEqual(parse(xml.replace(original, original + original)), parse(xml), field);
  }
  for (const aliases of [
    '<f:canceled>2026-10-04T12:00:00Z</f:canceled><f:cancellationDate>2026-10-04T13:00:00Z</f:cancellationDate>',
    '<f:cancellationDate>2026-10-04T13:00:00Z</f:cancellationDate><f:canceled>2026-10-04T12:00:00Z</f:canceled>',
  ]) assert.throws(() => parse(xml.replace('</f:EventExtension>', aliases + '</f:EventExtension>')), /conflicting-member-field/);
  assert.throws(() => parse(xml.replace('<e:text>', '<e:text><e:unknown>CLSD</e:unknown>')), /unsupported-member-field/);
  assert.throws(() => parse(xml.replace('</e:simpleText>', '</e:simpleText><e:formattedText>DIFFERENT</e:formattedText>')), /conflicting-member-field/);
});

test('member isolation preserves envelope counts and never catches missing identity, malformed XML or callback failures', () => {
  const other = notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002' });
  const xml = bulkXml([notice(), other]).replace('<f:lastUpdated>2026-10-04T11:59:00.000Z</f:lastUpdated>', '<f:lastUpdated>invalid</f:lastUpdated>');
  const records: NotamRecord[] = [], rejected: NotamMemberRejection[] = [];
  const parser = createNotamXmlParser(record => records.push(record), undefined, member => rejected.push(member));
  for (let at = 0; at < xml.length; at += 37) parser.write(xml.slice(at, at + 37));
  assert.equal(parser.finish().count, 2); assert.deepEqual(records.map(r => r.id), [other.id]);
  assert.deepEqual(rejected, [{ id: notice().id, reason: 'missing-update-time', sourceUpdatedAt: null }]);
  for (const broken of [xml.replace('numberReturned="2"', 'numberReturned="3"'), xml.slice(0, -10),
    xml.replace('NMS_ID_1757600000000001', 'unidentified')]) {
    assert.throws(() => { const p = createNotamXmlParser(() => {}, undefined, () => {}); p.write(broken); p.finish(); });
  }
  const failure = new Error('local writer failed'), p = createNotamXmlParser(() => { throw failure; }, undefined, () => assert.fail());
  assert.throws(() => p.write(bulkXml([notice()])), error => error === failure);
});

test('pending member recovery requires newer evidence and never trusts empty, sparse or partial replacement', () => {
  const record = base(), member = { id: record.id, reason: 'conflicting-member-field', sourceUpdatedAt: record.sourceUpdatedAt };
  const pending = pendingNotamMembers(undefined, [], [member], NOTAM_NOW);
  assert.equal(pendingNotamMembers(pending, [], [], NOTAM_NOW + 1).length, 1);
  assert.equal(pendingNotamMembers(pending, [record], [], NOTAM_NOW + 1).length, 1);
  const newer = { ...record, sourceUpdatedAt: record.sourceUpdatedAt.replace('.000Z', '.000000001Z') };
  assert.equal(pendingNotamMembers(pending, [newer], [], NOTAM_NOW + 1).length, 0);
  assert.equal(pendingNotamMembers(undefined, [newer], [member], NOTAM_NOW).length, 0, 'a qualified newer revision supersedes malformed older content');
  assert.equal(pendingNotamMembers(undefined, [], [member], NOTAM_NOW, undefined, [newer]).length, 0, 'older malformed input cannot discredit retained newer evidence');
  const unknown = pendingNotamMembers(undefined, [], [{ ...member, sourceUpdatedAt: null }], NOTAM_NOW);
  assert.equal(pendingNotamMembers(unknown, [{ ...record, updatedAt: NOTAM_NOW }], [], NOTAM_NOW + 1).length, 1);
  assert.equal(pendingNotamMembers(unknown, [{ ...record, updatedAt: NOTAM_NOW + 1 }], [], NOTAM_NOW + 1).length, 0);
  assert.equal(pendingNotamMembers(pending, [], [], NOTAM_NOW + 1, NOTAM_NOW).length, 1);
  assert.equal(pendingNotamMembers(pending, [], [], NOTAM_NOW + 1, NOTAM_NOW + 1).length, 0);
  const unrelated = { ...member, id: '1757600000000002' };
  assert.equal(pendingNotamMembers(pending, [], [unrelated], NOTAM_NOW + 1, NOTAM_NOW + 1).length, 2);
  assert.throws(() => pendingNotamMembers(undefined, [], Array.from({ length: 33 }, (_, i) => ({ ...member, id: String(1757600000000001 + i) })), NOTAM_NOW), /member-issue-limit/);
});

async function harness(t: TestContext, { bulkDue = false, seed = true, bulkAgeMs = 0 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'notam-ingestion-')), state = join(directory, 'staging');
  let now = NOTAM_NOW, updates: string[] = [], bulk = bulkXml([notice()], NOTAM_NOW);
  const calls: URL[] = [];
  if (seed) {
    const store = new NotamStore(state, 'staging', () => now);
    await store.restore();
    if (!bulkDue) { now -= bulkAgeMs; await store.admission.reserve('bulk'); now = NOTAM_NOW; }
    await store.publish({ schemaVersion: 2, environment: 'staging', records: [base()], complete: true,
      checkedAt: now, watermark: now, fullSyncAt: now, baselineAt: now }); await store.close();
  }
  const start = () => createNotamService({ enabled: true, environment: 'staging', directory,
    credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
    now: () => now, wait: async ms => { now += ms; }, signal: new AbortController().signal,
    sourceUrl: 'https://example.test/source/qualified.tar.gz', fetch: async input => {
      const url = new URL(String(input)); calls.push(url); now += 1001;
      if (url.pathname === '/v1/auth/token') return Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' });
      if (url.pathname.endsWith('/il')) return Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } });
      if (url.pathname.endsWith('/content/fixture')) return new Response(gzipSync(bulk));
      return Response.json({ status: 'Success', data: { aixm: updates } });
    },
  });
  let service = start(); await service.restore();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, state, calls, get now() { return now; }, get service() { return service; },
    set updates(value: string[]) { updates = value; }, set bulk(value: string) { bulk = value; },
    advance(ms: number) { now += ms; },
    async round() { now += 180_001; service.refresh(); await service.settled(); },
    async restart() { await service.close(); const budget = await readFile(join(state, 'budget.json'));
      const before = calls.length; service = start(); await service.restore();
      assert.equal(calls.length, before); assert.deepEqual(await readFile(join(state, 'budget.json')), budget); },
  };
}

test('partial deltas advance independent records, persist the gap across restart and recover without quota reset', async t => {
  const h = await harness(t), original = h.service.status;
  const healthy = notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002', locations: ['NEW'], icaoLocations: [], updatedAt: NOTAM_NOW });
  const input = [aixm(healthy), conflictingText(aixm(notice())), aixm(notice({ text: 'A VALID COPY CANNOT HIDE THE INVALID ONE' }))];
  h.updates = input;
  await h.round();
  assert.equal(h.service.status.state, 'degraded'); assert.equal(h.service.status.error, 'invalid-source-members');
  assert.equal(h.service.status.watermark, original.watermark); assert.equal(h.service.status.checkedAt, original.checkedAt);
  assert.equal(h.service.status.fullSyncAt, original.fullSyncAt); assert.equal(h.service.ingestion.pending, 1);
  assert.equal(h.service.readAirport({ faaId: 'NEW' })?.records.length, 1);
  assert.equal(h.service.readAirport({ faaId: 'TST' })?.records[0]?.text, base().text);
  assert.equal(h.service.readAirport({ faaId: 'NEW' })?.contentCoverage, 'incomplete');
  assert.ok(isNotamAirportSnapshot(h.service.readAirport({ faaId: 'NEW' })), 'existing public contract accepts partial delivery');
  const failedSource = join(h.state, 'delta-failures', (await readdir(join(h.state, 'delta-failures'))).find(name => name.endsWith('.json'))!);
  const archived = await readArchivedNotamBulk(failedSource);
  assert.equal(archived.kind, 'delta'); assert.equal(archived.sourceUrl, 'https://example.test/source/qualified.tar.gz');
  assert.deepEqual(JSON.parse(await readFile(archived.path, 'utf8')).data.aixm, input);
  const replay = await replayNotamBulk(failedSource, join(h.directory, 'replay'));
  assert.equal(replay.outcome, 'partial'); assert.equal(replay.rejected.length, 1);
  await h.restart(); assert.equal(h.service.ingestion.pending, 1); assert.equal(h.service.status.watermark, original.watermark);
  for (const updates of [[], [aixm(notice())]]) { h.updates = updates; await h.round(); assert.equal(h.service.ingestion.pending, 1); }
  h.updates = [aixm({ ...healthy, text: 'INDEPENDENT UPDATE', updatedAt: h.now })]; await h.round();
  assert.equal(h.service.readAirport({ faaId: 'NEW' })?.records[0]?.text, 'INDEPENDENT UPDATE');
  const previous = JSON.parse(await readFile(join(h.state, 'previous.json'), 'utf8'));
  assert.equal(previous.complete, true); assert.equal(previous.watermark, original.watermark);
  const next = notice({ updatedAt: h.now, text: 'RWY 09L CLSD' }); h.updates = [aixm(next)];
  await h.round(); assert.equal(h.service.status.state, 'ready'); assert.equal(h.service.ingestion.pending, 0);
  assert.equal(h.service.readAirport({ faaId: 'TST' })?.records[0]?.text, next.text);
  assert.ok(h.service.status.watermark! > original.watermark!);
  const deltas = h.calls.filter(url => url.pathname.endsWith('/notams'));
  assert.equal(new Set(deltas.map(url => url.search)).size, 1, 'every retry starts at the verified prefix');
  assert.equal(h.calls.filter(url => url.pathname.endsWith('/il')).length, 0);
  await h.restart(); assert.equal(h.service.status.state, 'ready');
});

test('rejected full snapshots retain existing membership and never establish an initial baseline', async t => {
  const h = await harness(t, { bulkDue: true }), original = h.service.status;
  const other = notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002', locations: ['NEW'], icaoLocations: [] });
  h.bulk = conflictingText(bulkXml([other], h.now)); await h.round();
  assert.equal(h.service.status.fullSyncAt, original.fullSyncAt); assert.equal(h.service.status.watermark, original.watermark);
  assert.equal(h.service.readAirport({ faaId: 'TST' })?.records.length, 1, 'omission in incomplete bulk is not withdrawal');
  assert.equal(h.service.ingestion.pending, 1);
  const empty = await harness(t, { bulkDue: true, seed: false }); empty.bulk = conflictingText(bulkXml([notice()], empty.now)); await empty.round();
  assert.equal(empty.service.status.generation, null); assert.equal(empty.service.status.state, 'unavailable');
});

test('obsolete malformed members establish presence without discrediting or withdrawing retained newer revisions', async t => {
  const h = await harness(t, { bulkDue: true });
  h.bulk = conflictingText(bulkXml([notice({ updatedAt: NOTAM_NOW - 3600_000 })], h.now));
  await h.round(); assert.equal(h.service.reconciliation?.pending, true); assert.equal(h.service.ingestion.pending, 0);
  await h.round(); assert.equal(h.service.status.state, 'ready');
  assert.equal(h.service.readAirport({ faaId: 'TST' })?.records[0]?.revision, base().revision);
});

for (const repair of ['newer-record', 'withdrawal'] as const) for (const restart of [false, true]) {
  test(`a complete replacement closes an ingestion gap by ${repair}${restart ? ' across restart' : ''}`, async t => {
    const h = await harness(t, { bulkAgeMs: NOTAM_DAY_MS - 600_000 }), original = h.service.status;
    h.updates = [conflictingText(aixm(notice()))]; await h.round();
    assert.equal(h.service.ingestion.pending, 1);
    h.advance(600_001); h.updates = [];
    const replacement = notice({ updatedAt: h.now, text: 'NEW VALID REVISION' });
    h.bulk = bulkXml(repair === 'withdrawal' ? [] : [replacement], h.now);
    await h.round(); assert.equal(h.service.reconciliation?.pending, true);
    assert.equal(h.service.status.fullSyncAt, original.fullSyncAt, 'full load stays private until its bridge validates');
    if (restart) {
      await h.restart();
      if (repair === 'newer-record') h.updates = [conflictingText(aixm(notice()))];
    }
    await h.round();
    assert.equal(h.service.ingestion.pending, 0); assert.equal(h.service.status.state, 'ready');
    assert.equal(h.service.reconciliation?.state, 'current');
    assert.ok(h.service.status.fullSyncAt! > original.fullSyncAt!);
    assert.ok(h.service.status.watermark! > original.watermark!);
    assert.deepEqual(h.service.readAirport({ faaId: 'TST' })?.records.map(record => record.text),
      repair === 'withdrawal' ? [] : [replacement.text]);
    assert.equal(h.calls.filter(url => url.pathname.endsWith('/il')).length, 1);
    await h.restart(); assert.equal(h.service.status.state, 'ready');
  });
}

test('malformed-only deltas preserve the complete checkpoint through partial updates, closure and damaged-current recovery', async t => {
  const h = await harness(t), original = h.service.status;
  h.updates = [conflictingText(aixm(notice()))]; await h.round();
  assert.equal(h.service.status.generation, original.generation, 'only manifest completeness changed');
  const previous = await readFile(join(h.state, 'previous.json'), 'utf8');
  assert.equal(JSON.parse(previous).complete, true); assert.equal(JSON.parse(previous).watermark, original.watermark);
  await h.restart(); h.updates = []; await h.round();
  const independent = notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002', updatedAt: h.now });
  h.updates = [aixm(independent)]; await h.round();
  assert.equal(h.service.ingestion.pending, 1);
  assert.equal(await readFile(join(h.state, 'previous.json'), 'utf8'), previous);
  const repaired = notice({ updatedAt: h.now, text: 'REPAIRED REVISION' });
  h.updates = [aixm(repaired)]; await h.round();
  assert.equal(h.service.status.state, 'ready');
  assert.equal(await readFile(join(h.state, 'previous.json'), 'utf8'), previous, 'gap closure preserves the complete anchor');
  await writeFile(join(h.state, 'current.json'), '{interrupted'); await h.restart();
  assert.equal(h.service.status.generation, original.generation);
  assert.equal(h.service.status.collectionContinuity, 'incomplete', 'restoring previous still requires a verified replay');
  h.updates = [aixm(repaired), aixm(independent)]; await h.round();
  assert.equal(h.service.status.state, 'ready'); assert.equal(h.service.status.recordCount, 2);
  assert.equal(h.calls.filter(url => url.pathname.endsWith('/il')).length, 0);
});

test('a malformed bootstrap bridge remains private and retains its gaps through restart and empty retries', async t => {
  const h = await harness(t, { seed: false }); await h.round();
  h.updates = [conflictingText(aixm(notice()))]; await h.round();
  assert.equal(h.service.status.state, 'unavailable');
  assert.equal(h.service.readAirport({ faaId: 'TST' }), undefined);
  assert.equal(h.service.ingestion.pending, 1);
  await h.restart(); h.updates = []; await h.round();
  assert.equal(h.service.status.state, 'unavailable'); assert.equal(h.service.ingestion.pending, 1);
  h.updates = [aixm(notice({ updatedAt: h.now, text: 'REPAIRED BOOTSTRAP' }))]; await h.round();
  assert.equal(h.service.status.state, 'ready'); assert.equal(h.service.ingestion.pending, 0);
  assert.equal(h.service.readAirport({ faaId: 'TST' })?.records[0]?.text, 'REPAIRED BOOTSTRAP');
  assert.equal(h.calls.filter(url => url.pathname.endsWith('/il')).length, 1);
});

test('expired private candidates retain rejected-member evidence until a qualifying full replacement', async t => {
  const h = await harness(t, { seed: false }); await h.round();
  h.updates = [conflictingText(aixm(notice()))]; await h.round(); h.updates = [];
  h.advance(NOTAM_DAY_MS - 9 * 60_000 - (h.now - NOTAM_NOW));
  const requests = h.calls.length; await h.round();
  assert.equal(h.calls.length, requests, 'an expired candidate cannot dispatch an out-of-window delta');
  assert.equal(h.service.status.error, 'delta-window-exceeded'); assert.equal(h.service.ingestion.pending, 1);
  await h.restart(); h.advance(20 * 60_000);
  const other = notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002', updatedAt: h.now });
  h.bulk = bulkXml([notice(), other], h.now).replace(aixm(other), conflictingText(aixm(other)));
  await h.round();
  assert.equal(h.service.status.state, 'unavailable'); assert.equal(h.service.ingestion.pending, 2);
  await h.restart(); assert.equal(h.service.ingestion.pending, 2);
  h.advance(NOTAM_DAY_MS + 600_000); h.bulk = bulkXml([], h.now);
  await h.round(); assert.equal(h.service.reconciliation?.pending, true);
  await h.round(); assert.equal(h.service.status.state, 'ready'); assert.equal(h.service.ingestion.pending, 0);
  assert.equal(h.service.status.recordCount, 0);
  assert.equal(h.calls.filter(url => url.pathname.endsWith('/il')).length, 3);
});

test('a newly malformed replacement bridge preserves the live prefix and its independent updates', async t => {
  const h = await harness(t, { bulkDue: true }), original = h.service.status;
  h.bulk = bulkXml([notice({ updatedAt: h.now, text: 'UNBRIDGED REPLACEMENT' })], h.now); await h.round();
  const healthy = notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002', locations: ['NEW'], icaoLocations: [], updatedAt: h.now });
  h.updates = [conflictingText(aixm(notice({ updatedAt: h.now }))), aixm(healthy)]; await h.round();
  assert.equal(h.service.status.fullSyncAt, original.fullSyncAt); assert.equal(h.service.status.watermark, original.watermark);
  assert.equal(h.service.readAirport({ faaId: 'TST' })?.records[0]?.text, base().text);
  assert.equal(h.service.readAirport({ faaId: 'NEW' })?.records[0]?.id, healthy.id);
  assert.equal(h.service.ingestion.pending, 1); assert.equal(h.service.reconciliation?.pending, false);
  h.updates = [aixm(notice({ updatedAt: h.now, text: 'REPAIRED LIVE PREFIX' }))]; await h.round();
  assert.equal(h.service.status.state, 'ready'); assert.equal(h.service.reconciliation?.state, 'failed');
  assert.equal(h.service.status.fullSyncAt, original.fullSyncAt, 'a successful live delta cannot claim the failed replacement');
});
