import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNotamSourceIssue, isNotamSnapshot, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import capture from './fixtures/notams-state-2026-10-16.json';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { compareNotamContent, resolveNotamRevision } from '../tools/info-server/notams/revision';
import { classifyNotamIssue } from '../tools/info-server/notams/source-issues';
import { NotamStore } from '../tools/info-server/notams/store';
import { createInfoServer } from '../tools/info-server/server';
import { createNotamResponder } from '../tools/info-server/notams/http';
import { replayNotams, assertReviewedNotamReplay } from '../tools/replay-notams';

const issues = capture.issues.map(value => { assert.ok(isNotamSourceIssue(value)); return value; });
const daa = issues[0]!, rich = daa.variants[1]!, end = rich.endsAt!;
const changed = (record: NotamRecord, patch: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = record; return recordWithRevision({ ...facts, ...patch });
};
function* permutations<T>(values: readonly T[]): Generator<T[]> {
  if (!values.length) { yield []; return; }
  for (let i = 0; i < values.length; i++)
    for (const rest of permutations(values.filter((_, index) => index !== i))) yield [values[i]!, ...rest];
}
function* partitions<T>(values: readonly T[]): Generator<T[][]> {
  for (let mask = 0; mask < 2 ** (values.length - 1); mask++) {
    const batches: T[][] = [[]];
    values.forEach((value, i) => { if (i && mask & 1 << (i - 1)) batches.push([]); batches.at(-1)!.push(value); });
    yield batches;
  }
}
const different = changed(rich, {
  text: rich.text.replace('14/32', '15/33'),
  translations: rich.translations.map(t => ({ ...t, text: t.text.replace('14/32', '15/33') })),
});
const conflict = collectNotamRecords({ records: [] }, [rich, different]).issues![0]!;

test('captured separator loss reconciles across arrival orders, batch partitions, sparse replay and full rebasing', () => {
  const sparse = changed(rich, { translations: rich.translations.filter(t => t.type === 'OTHER:ICAO') });
  for (const order of permutations([...daa.variants, sparse])) for (const batches of partitions(order)) {
    let collection: ReturnType<typeof collectNotamRecords> = { records: [] };
    for (const batch of batches) collection = collectNotamRecords(collection, batch);
    assert.equal(collection.records.length, 1); assert.equal(collection.issues?.length ?? 0, 0);
    const record = collection.records[0]!;
    assert.equal(record.text, rich.text, 'select an original body retaining the witnessed separator');
    assert.equal(record.sourceUpdatedAt, rich.sourceUpdatedAt);
    for (const translation of daa.variants.flatMap(v => v.translations))
      assert.ok(record.translations.some(t => t.type === translation.type && t.text === translation.text));
    assert.equal(collectNotamRecords(collection, [...order, ...order]), collection);
    assert.equal(rebaseNotamRecords(collection, [daa.variants[0]!], end).issues?.length ?? 0, 0);
  }
  const decision = resolveNotamRevision(daa.variants);
  assert.equal(decision.kind, 'resolved');
  if (decision.kind === 'resolved') assert.ok(decision.proofs.includes('icao-line-break'));
});

test('changed content, boundaries and unsupported evidence survive all sequence partitions', () => {
  for (const order of permutations([...daa.variants, different])) for (const batches of partitions(order)) {
    let collection: ReturnType<typeof collectNotamRecords> = { records: [] };
    for (const batch of batches) collection = collectNotamRecords(collection, batch);
    assert.equal(collection.records.length, 0); assert.equal(collection.issues?.length, 1);
    const replay = collectNotamRecords(collection, [rich]);
    assert.equal(replay.records.length, 0); assert.equal(replay.issues?.length, 1, 'a sparse replay cannot erase contrary evidence');
    assert.equal(collectNotamRecords(replay, [rich]), replay, 'enriched evidence stabilizes on repeated delivery');
    assert.equal(rebaseNotamRecords(collection, [rich], end).issues?.length, 1);
  }
  const collapsed = daa.variants[0]!;
  const mutations = [
    changed(rich, { text: rich.text.replace('14/32', '14/33') }),
    changed(rich, { text: rich.text.replace(/\r\n/g, ' ') }), // no literal witness remains
    changed(rich, { text: rich.text.replace('MONITORED', 'MONITOR ED') }),
    changed(rich, { translations: [] }),
    changed(rich, { translations: rich.translations.map(t => ({ ...t, text: t.text.replace('2610161000', '2610161100') })) }),
    changed(rich, { translations: rich.translations.map(t => ({ ...t, text: t.text.replace('QMRXX', 'QMRLC') })) }),
    changed(rich, { translations: [...rich.translations, { type: 'OTHER:UNKNOWN', text: 'additional evidence' }] }),
    changed(rich, { sourceUpdatedAt: rich.sourceUpdatedAt, effectiveEnd: '202610161100', endsAt: end + 3600_000 }),
  ];
  for (const variant of mutations) {
    // The second case also removes the literal break in its ICAO rendering.
    const next = variant === mutations[1] ? changed(variant, {
      translations: variant.translations.map(t => ({ ...t, text: t.text.replace(/\r\n/g, ' ') })),
    }) : variant;
    for (const order of [[collapsed, next], [next, collapsed]])
      assert.equal(resolveNotamRevision(order).kind, 'unresolved');
  }
  for (const [before, after] of [['WET', 'DRY'], ['MONITORED', 'monitored'], ['1000.', '1000!'],
    ['14/32', '14/33'], ['2610160400', '2610160401']]) {
    const next = changed(rich, { text: rich.text.replace(before!, after!),
      translations: rich.translations.map(t => ({ ...t, text: t.text.replace(before!, after!) })) });
    assert.equal(resolveNotamRevision([collapsed, next]).kind, 'unresolved');
  }
  assert.deepEqual(compareNotamContent(...daa.variants as [NotamRecord, NotamRecord]).fields, []);
});

test('revision and lifecycle authority remain independent of representation proofs', () => {
  const cancelled = changed(rich, { lifecycle: 'cancelled', canceledAt: new Date(rich.updatedAt + 1000).toISOString() });
  for (const order of permutations([...daa.variants, different, cancelled])) {
    const result = resolveNotamRevision(order);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.record.lifecycle, 'cancelled');
  }
  const newer = changed(different, { updatedAt: rich.updatedAt + 1000, sourceUpdatedAt: new Date(rich.updatedAt + 1000).toISOString(), sequence: 0 });
  const resolved = collectNotamRecords({ records: [], issues: [conflict] }, [newer]);
  assert.equal(resolved.issues?.length, 0); assert.equal(resolved.records[0]?.revision, newer.revision);
  assert.equal(resolveNotamRevision([changed(rich, { lifecycle: 'unknown' })]).kind, 'unresolved');
  assert.equal(collectNotamRecords({ records: [], issues: [{ ...conflict, variantsTruncated: true }] }, [rich]).issues?.[0]?.variantsTruncated, true);
  assert.equal(rebaseNotamRecords({ records: [], issues: [conflict] }, [], rich.updatedAt).issues?.length, 1);
  assert.equal(rebaseNotamRecords({ records: [], issues: [conflict] }, [], end).issues?.length, 0);
});

test('historical qualification requires complete, scoped, agreeing fixed validity evidence', () => {
  assert.equal(classifyNotamIssue(conflict, end - 1).blocking, true);
  assert.equal(classifyNotamIssue(conflict, end).applicability.state, 'historical');
  assert.equal(classifyNotamIssue(conflict, end).blocking, false);
  const patches: Partial<NotamSourceIssue>[] = [
    { variantsTruncated: true }, { unscoped: true }, { reason: 'unsupported-lifecycle' },
    { variants: [rich, changed(different, { lifecycle: 'unknown' })] },
    { variants: [rich, changed(different, { endKind: 'estimated', effectiveEnd: different.effectiveEnd + 'EST' })] },
    { variants: [rich, changed(different, { effectiveEnd: 'PERM', endsAt: null })] },
    { variants: [rich, changed(different, { endsAt: end + 60_000 })] },
    { variants: [rich, changed(different, { effectiveStart: '202610160230' })] },
    { variants: [rich, changed(different, { translations: [{ type: 'UNKNOWN', text: 'unparsed validity' }] })] },
    { variants: [rich, changed(different, { translations: different.translations.map(t => ({ ...t, text: t.text.replace('2610161000', '2610161100') })) })] },
  ];
  for (const patch of patches) {
    const classification = classifyNotamIssue({ ...conflict, ...patch }, end + 2 * 86400_000);
    assert.equal(classification.applicability.state, 'unknown'); assert.equal(classification.blocking, true);
  }
  for (const issue of issues.slice(1)) {
    const c = classifyNotamIssue(issue, Date.parse(capture.capturedAt));
    assert.equal(c.blocking, true); assert.ok(c.resolved); assert.equal(c.affectedIcaoQueries.length, 2);
  }
});

test('issue observations retain uncertainty about legacy history and never become revision authority', () => {
  let collection = collectNotamRecords({ records: [] }, [rich, different], { at: end - 1000, kind: 'delta' });
  collection = collectNotamRecords(collection, [rich], { at: end, kind: 'bulk' });
  collection = collectNotamRecords(collection, [different], { at: end - 500, kind: 'delta' });
  assert.deepEqual(collection.issues?.[0]?.observations, { firstSeenAt: end - 1000, lastSeenAt: end, kinds: ['bulk', 'delta'] });
  const older = changed(rich, { updatedAt: rich.updatedAt - 1000, sourceUpdatedAt: new Date(rich.updatedAt - 1000).toISOString() });
  assert.equal(collectNotamRecords(collection, [older], { at: end + 1000, kind: 'bulk' }), collection,
    'an obsolete source revision is not another observation of the retained conflict');
  assert.equal(collection.issues?.[0]?.variants[0]?.sourceUpdatedAt, rich.sourceUpdatedAt);
  const legacy = collectNotamRecords({ records: [], issues: [conflict] }, [rich], { at: end, kind: 'delta' });
  assert.equal(legacy.issues?.[0]?.observations?.firstSeenAt, null);
  assert.ok(isNotamSourceIssue(legacy.issues?.[0]));
  assert.equal(isNotamSourceIssue({ ...conflict, observations: { firstSeenAt: end, lastSeenAt: end - 1, kinds: ['delta'] } }), false);
});

async function seed(directory: string, entries: NotamSourceIssue[], at: number) {
  const state = join(directory, 'production'), store = new NotamStore(state, 'production', () => at);
  await store.restore(); await store.admission.reserve('bulk');
  await store.publish({ schemaVersion: 2, environment: 'production', records: [], issues: entries,
    complete: true, checkedAt: at, watermark: at, fullSyncAt: at, baselineAt: at });
  await store.close(); return state;
}

test('clock transitions, rollback and restore update health and cached HTTP impact without source or journal changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-impact-'));
  let now = end - 1, requests = 0;
  const observed = collectNotamRecords({ records: [] }, conflict.variants, { at: now, kind: 'delta' }).issues![0]!;
  const state = await seed(directory, [observed], now), budget = await readFile(join(state, 'budget.json'));
  const manifest = await readFile(join(state, 'current.json'));
  const open = () => createInfoServer({ directory: join(directory, 'weather'), startUpdates: false, now: () => now,
    notams: { enabled: true, environment: 'production', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    fetch: async () => { requests++; assert.fail('Impact assessment must not request source data'); } });
  let app = await open();
  try {
    await app.notams.restore();
    for (let restart = 0; restart < 2; restart++) {
      await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
      const address = app.server.address(); assert.ok(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
      const responder = createNotamResponder(app.notams);
      for (const at of [end - 1, end, end - 1, end + 1, rich.startsAt! - 1, rich.startsAt!, end + 1]) {
        now = at;
        const historical = now >= end;
        const response = responder.read('/api/notams/airports?faaId=DAA&icaoId=KDAA', undefined);
        const snapshot = JSON.parse(response.body.toString()); assert.ok(isNotamSnapshot(snapshot));
        assert.equal(snapshot.issues?.length, historical ? 0 : 1);
        assert.equal(snapshot.historicalIssues?.length ?? 0, historical ? 1 : 0);
        assert.equal(snapshot.feed.historicalIssues, historical ? 1 : 0);
        assert.equal(snapshot.feed.blockingRecords, historical ? 0 : 1);
        assert.equal(snapshot.feed.unresolvedRecords, 1);
        assert.deepEqual((snapshot.issues?.[0] ?? snapshot.historicalIssues?.[0])?.observations, observed.observations);
        assert.equal(app.notams.sourceIssues?.samples[0]?.impact, historical ? 'historical' : 'unresolved-content');
        assert.deepEqual(responder.read('/api/notams/airports?faaId=DAA&icaoId=KDAA', undefined).body, response.body);
        const delivered = await (await fetch(origin + '/api/notams/airports?faaId=DAA&icaoId=KDAA',
          { headers: { 'accept-encoding': 'gzip' } })).json();
        assert.deepEqual(delivered, snapshot);
        const health = await (await fetch(origin + '/api/weather/healthz')).json();
        assert.deepEqual(health.notams, snapshot.feed);
        assert.equal(health.readiness.warnings.some((warning: { reason: string }) => warning.reason === 'historical-source-issues'), historical);
        assert.deepEqual(health.notamSourceIssues.samples[0].observations, observed.observations);
        if (historical) {
          assert.equal(isNotamSnapshot({ ...snapshot, historicalIssues: [observed, observed] }), false);
          assert.equal(isNotamSnapshot({ ...snapshot, historicalIssues: [{ ...observed, variantsTruncated: true }] }), false);
          assert.equal(isNotamSnapshot({ ...snapshot, historicalIssues: [{ ...observed, variants: [rich] }] }), false);
        }
      }
      await app.close(); app = await open(); await app.notams.restore();
    }
    assert.equal(requests, 0);
    assert.deepEqual(await readFile(join(state, 'budget.json')), budget);
    assert.deepEqual(await readFile(join(state, 'current.json')), manifest);

  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('offline release replay explains reconsidered records and leaves frozen state and admission untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-release-replay-'));
  const at = Date.parse(capture.capturedAt), state = await seed(directory, issues, at);
  const budget = await readFile(join(state, 'budget.json')), manifest = await readFile(join(state, 'current.json'));
  try {
    const result = await replayNotams({ directory: state, environment: 'production', at });
    assert.equal(result.sourceRequests, 0); assert.equal(result.sourceClocksUnchanged, true);
    assert.equal(result.admissionUnchanged, true); assert.equal(result.candidateFeed.blockingRecords, 0);
    assert.deepEqual(result.changes.map(change => [change.id, change.from, change.to]), issues.map(issue => [issue.id, 'issue', 'record']).sort());
    assert.ok(result.changes.find(change => change.id === daa.id)?.proofs.includes('icao-line-break')); assert.ok(result.queriesChecked >= 10);
    assert.deepEqual(await readFile(join(state, 'budget.json')), budget);
    assert.deepEqual(await readFile(join(state, 'current.json')), manifest);
    assert.throws(() => assertReviewedNotamReplay(result, result), /requires a baseline/);
    const comparison = await replayNotams({ directory: state, environment: 'production', at,
      baselineServer: new URL('../tools/info-server/server.ts', import.meta.url).pathname });
    assert.equal(comparison.baselineCompared, true); assert.equal(comparison.healthChanges, null);
    assert.deepEqual(comparison.changes, []); assert.deepEqual(comparison.queryChanges, []); assert.deepEqual(comparison.impactChanges, []);
    assert.doesNotThrow(() => assertReviewedNotamReplay(comparison, comparison));
    assert.throws(() => assertReviewedNotamReplay(comparison, { ...comparison, candidateFeed: { ...comparison.candidateFeed, blockingRecords: 1 } }), /Unreviewed/);
    await symlink(join(state, 'budget.json'), join(state, 'linked.json'));
    await assert.rejects(replayNotams({ directory: state, environment: 'production', at }), /regular files/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
