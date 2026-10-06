import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { isRecord, isNotamAirportSnapshot, isNotamSourceIssue, NOTAM_MAX_ISSUE_VARIANTS, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import { collectNotamRecords } from '../tools/info-server/notams/collection';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { NotamStore } from '../tools/info-server/notams/store';
import { createNotamService } from '../tools/info-server/notams/service';
import { createNotamResponder } from '../tools/info-server/notams/routes';
import { aixm } from './fixtures/notams';

// These were already present in the frozen reader corpus. Reader preservation
// alone did not exercise whether collection could reconcile their source facts.
const snapshots = gunzipSync(readFileSync(new URL('./fixtures/notams-us1000/snapshots.jsonl.gz', import.meta.url)))
  .toString('utf8').trimEnd().split('\n').map(line => {
    const value: unknown = JSON.parse(line); assert.ok(isNotamAirportSnapshot(value)); return value;
  });
// Later source pairs exposed omitted/partial schedules and wrapped body text.
const renderings: unknown = JSON.parse(readFileSync(new URL('./fixtures/notams-source-renderings-2026-10-06.json', import.meta.url), 'utf8'));
assert.ok(isRecord(renderings) && typeof renderings.checkedAt === 'number' &&
  Array.isArray(renderings.issues) && renderings.issues.every(isNotamSourceIssue));
const representationIssues = renderings.issues;
const cancellations: unknown = JSON.parse(readFileSync(new URL('./fixtures/notams-cancellation-2026-10-06.json', import.meta.url), 'utf8'));
assert.ok(isRecord(cancellations) && typeof cancellations.checkedAt === 'number' &&
  Array.isArray(cancellations.issues) && cancellations.issues.every(isNotamSourceIssue));
const issues = [...new Map(snapshots.flatMap(s => s.issues ?? []).map(issue => [issue.id, issue])).values(),
  ...representationIssues, ...cancellations.issues];
const now = Math.max(...snapshots.map(s => s.feed.checkedAt!), renderings.checkedAt, cancellations.checkedAt);
function changed(record: NotamRecord, fields: Partial<NotamRecord>) {
  const { revision: _revision, ...facts } = { ...record, ...fields };
  return recordWithRevision(facts);
}

test('captured source pairs reconcile in both arrival orders without losing raw translations or source time', () => {
  assert.equal(issues.length, 22);
  for (const issue of issues) for (const variants of [issue.variants, [...issue.variants].reverse()]) {
    let collection = collectNotamRecords({ records: [] }, [variants[0]!]);
    collection = collectNotamRecords(collection, variants.slice(1));
    assert.equal(collection.issues?.length ?? 0, 0, issue.id);
    assert.equal(collection.records.length, 1, issue.id);
    const record = collection.records[0]!;
    assert.ok(variants.some(r => r.text === record.text), 'retain an original body, including its whitespace');
    assert.equal(record.updatedAt, variants[0]!.updatedAt);
    assert.equal(record.startsAt, variants[0]!.startsAt);
    assert.equal(record.endsAt, variants[0]!.endsAt);
    if (variants.some(r => r.lifecycle === 'cancelled')) assert.equal(record.lifecycle, 'cancelled');
    else {
      for (const source of variants.flatMap(r => r.translations)) {
        const normalize = (text: string) => text.trim().replace(/^<pre>([\s\S]*)<\/pre>$/i, '$1').replace(/\s+/g, ' ').trim();
        assert.ok(record.translations.some(t => t.type === source.type && normalize(t.text) === normalize(source.text)), issue.id);
      }
      if (variants.some(r => r.endKind === 'estimated')) assert.equal(record.endKind, 'estimated', issue.id);
    }
    assert.equal(collectNotamRecords(collection, [...variants, ...variants]), collection, `${issue.id}: idempotent replay`);
  }
});

test('native schedule evidence supplements missing metadata and retains supplied hours through sparse replays', () => {
  const expected = new Map([
    ['3470508447286252', 'WED THU FRI'], ['4084776096364174', 'Daily:2359-1000~DLY 2359-1000'],
    ['4690820396922953', 'SAT SUN 1100-0300'], ['5560062601888734', 'Daily:1300-2300~DLY 1300-2300'],
    ['6218155093458891', 'Daily:1058-2200~DLY 1058-2200'],
  ]);
  for (const [id, schedule] of expected) {
    const variants = issues.find(i => i.id === id)!.variants;
    for (const order of [variants, [...variants].reverse()]) {
      const collection = collectNotamRecords({ records: [order[0]!] }, order.slice(1));
      assert.equal(collection.records[0]?.schedule, schedule, id);
      assert.equal(collectNotamRecords(collection, [...variants, changed(variants[0]!, { schedule: '' })]), collection);
    }
  }
});

test('representation differences require complete, shared and correctly identified native evidence', () => {
  for (const issue of representationIssues) {
    const alterations = [
      (text: string) => text.replace(/^!\S+/, '!XXX'),
      (text: string) => text.replace(/\d{10}-\d{10}$/, '2610010000-2610020000'),
    ];
    const variants = [issue.variants.map(r => changed(r, { translations: r.translations.filter(t => t.type !== 'LOCAL_FORMAT') })),
      ...alterations.map(alter => issue.variants.map(r => changed(r, { translations: r.translations.map(t =>
        t.type === 'LOCAL_FORMAT' ? { ...t, text: alter(t.text) } : t) }))),
      issue.variants.map(r => changed(r, { translations: [...r.translations, { type: 'LOCAL_FORMAT', text: 'Conflicting native text' }] }))];
    for (const pair of variants) {
      assert.equal(collectNotamRecords({ records: [] }, pair).issues?.length, 1, issue.id);
    }
  }
});

test('schedule disagreement survives empty metadata and every arrival order', () => {
  const [sparse, full] = issues.find(i => i.id === '4690820396922953')!.variants;
  for (const schedule of ['SAT', 'MON SUN', 'SAT SUN 1200-0300', 'SAT SUN 1100-0400', 'SAT SUN 2460-0300',
    'SAT SUN SR-SS', 'SAT SUN 1100-0300 EXC HOL', 'H24', 'Daily:1100-0300~DLY 1200-0300']) {
    const conflict = changed(full!, { schedule }), empty = changed(sparse!, { schedule: '' });
    for (const records of [[sparse!, full!, conflict], [sparse!, conflict, full!], [full!, sparse!, conflict],
      [full!, conflict, sparse!], [conflict, sparse!, full!], [conflict, full!, sparse!], [full!, conflict, empty]]) {
      let collection = collectNotamRecords({ records: [] }, [records[0]!]);
      for (const record of records.slice(1)) collection = collectNotamRecords(collection, [record]);
      assert.equal(collection.records.length, 0, schedule); assert.equal(collection.issues?.length, 1);
      assert.equal(collectNotamRecords(collection, [sparse!, full!, empty]).issues?.length, 1, schedule);
      assert.equal(collectNotamRecords({ records: [] }, records).issues?.length, 1, 'batch reconciliation keeps the same disagreement');
    }
  }
});

test('native schedule matching understands weekday ranges and daily windows without broadening the supplied days', () => {
  const source = issues.find(i => i.id === '4690820396922953')!.variants[0]!;
  const withSchedule = (bodySchedule: string, schedule: string) => changed(source, {
    text: source.text.replace('SAT SUN 1100-0300', bodySchedule), schedule,
    translations: source.translations.map(t => ({ ...t, text: t.text.replace('SAT SUN 1100-0300', bodySchedule) })),
  });
  for (const [body, sparse, full] of [
    ['MON-FRI 1100-0300', 'MON TUE WED THU FRI', 'MON-FRI 1100-0300'],
    ['FRI-MON 1100-0300', 'FRI SAT SUN MON', 'FRI-MON 1100-0300'],
    ['DLY 0000-2400', '', 'Daily:0000-2400~DLY 0000-2400'],
    ['SUN 1100-0300', 'SUN', 'SUN 1100-0300'],
  ]) {
    const variants = [withSchedule(body!, sparse!), withSchedule(body!, full!)];
    for (const order of [variants, [...variants].reverse()]) {
      const collection = collectNotamRecords({ records: [order[0]!] }, order.slice(1));
      assert.equal(collection.issues?.length ?? 0, 0, body);
      assert.equal(collection.records[0]?.schedule, full, body);
      const different = changed(collection.records[0]!, { schedule: 'TUE 1100-0300' });
      assert.equal(collectNotamRecords(collection, [different]).issues?.length, 1);
    }
  }
  for (const tail of ['SAT SUN 2500-0300', 'SAT SUN 2400-0300', 'SAT SUN 1100-2460', 'SAT SUN 1100-1100',
    'SAT SUN 1100-0300 EXC HOL', 'SAT SUN 1100-0300 AND 1200-0400']) {
    const pair = [withSchedule(tail, 'SAT SUN'), withSchedule(tail, tail)];
    assert.equal(collectNotamRecords({ records: [] }, pair).issues?.length, 1, tail);
  }
  for (const body of ['SAT SUN 1100-0300 MON 1200-0400', 'SAT SUN EXC MON 1200-0400', 'EXC MON 1200-0400']) {
    const pair = [withSchedule(body, ''), withSchedule(body, 'MON 1200-0400')];
    assert.equal(collectNotamRecords({ records: [] }, pair).issues?.length, 1, 'one suffix cannot establish a compound/excepted schedule');
  }
});

test('body wrapping does not discard original text or admit changed words, punctuation, units or digits', () => {
  const variants = issues.find(i => i.id === '1893333917728834')!.variants;
  for (const order of [variants, [...variants].reverse()]) {
    const collection = collectNotamRecords({ records: [order[0]!] }, order.slice(1));
    assert.equal(collection.records[0]?.text, order[0]!.text);
    for (const text of [order[1]!.text.replace('110FT', '111FT'), order[1]!.text.replace('110FT', '110M'),
      order[1]!.text.replace('FLAGGED', 'FLAGGED AND LGTD'), order[1]!.text.toLowerCase(),
      order[1]!.text.replace('(110FT AGL)', '110FT AGL'), order[1]!.text.replace('CRANE ', 'CRANE'),
      `<pre>${order[1]!.text}</pre>`]) {
      assert.equal(collectNotamRecords(collection, [changed(order[1]!, { text })]).issues?.length, 1);
    }
  }
});

test('complete source evidence survives sparse representations while changed core facts remain unresolved', () => {
  const record = issues.find(i => i.id === '3547032142897389')!.variants[0]!;
  const sparse = changed(record, { icaoLocations: [], translations: record.translations.filter(t => t.type === 'LOCAL_FORMAT') });
  for (const variants of [[record, sparse], [sparse, record]]) {
    const result = collectNotamRecords({ records: [] }, variants);
    assert.equal(result.issues?.length ?? 0, 0);
    assert.deepEqual(result.records[0]?.icaoLocations, record.icaoLocations);
  }
  for (const fields of [{ text: record.text + ' EXC EMERG ACFT' }, { number: '9999' },
    { effectiveEnd: '202610070400', endsAt: Date.parse('2026-10-07T04:00:00Z') },
    { icaoLocations: ['KXXX'] }, { schedule: 'DLY 0400-0500' }]) {
    const result = collectNotamRecords({ records: [record] }, [changed(record, fields)]);
    assert.equal(result.issues?.length, 1, JSON.stringify(fields));
  }
});

test('replaying retained ICAO renderings without their optional local translation preserves resolved notices', () => {
  const variants = issues.find(i => i.id === '3547032142897389')!.variants;
  const sparse = variants.map(record => changed(record, {
    translations: record.translations.filter(t => t.type === 'OTHER:ICAO'),
  }));
  for (const order of [variants, [...variants].reverse()]) {
    let resolved = collectNotamRecords({ records: [] }, [order[0]!]);
    resolved = collectNotamRecords(resolved, order.slice(1));
    assert.equal(resolved.records.length, 1);
    for (const record of sparse) assert.equal(collectNotamRecords(resolved, [record]), resolved);
    assert.equal(collectNotamRecords(resolved, [...sparse, ...variants]), resolved);
    for (const record of sparse) {
      const restored = collectNotamRecords({ records: [] }, [record, resolved.records[0]!]);
      assert.equal(restored.issues?.length ?? 0, 0, 'checkpoint ordering cannot turn the same evidence into a conflict');
    }

    for (const record of [changed(sparse[0]!, { text: sparse[0]!.text + ' EXC EMERG ACFT' }),
      changed(sparse[0]!, { translations: [...sparse[0]!.translations,
        { type: 'OTHER:ICAO', text: sparse[0]!.translations[0]!.text + ' EXC EMERG ACFT' }] })]) {
      assert.equal(collectNotamRecords(resolved, [record]).issues?.length, 1, 'new evidence still constrains the notice');
    }
  }
  const unqualified = collectNotamRecords({ records: [] }, sparse);
  assert.equal(unqualified.issues?.length, 1, 'different renderings still need native evidence to reconcile');
  assert.equal(collectNotamRecords(unqualified, sparse), unqualified, 'a sparse replay cannot erase an existing conflict');
  const combined = changed(sparse[0]!, { translations: sparse.flatMap(record => record.translations) });
  assert.equal(collectNotamRecords({ records: [combined] }, sparse).issues?.length, 1,
    'an unqualified superset cannot establish compatibility between different ICAO renderings');
});

test('lifecycle precedence requires the original-ID cancellation timestamp and matching source identity', () => {
  const issue = issues.find(i => i.id === '8443673449471385')!;
  const active = issue.variants.find(r => r.lifecycle === 'active')!;
  const cancelled = issue.variants.find(r => r.lifecycle === 'cancelled')!;
  for (const fields of [{ canceledAt: '' }, { canceledAt: 'invalid' },
    { canceledAt: new Date(cancelled.updatedAt - 60_000).toISOString() },
    { classification: 'FDC' }, { number: '9999' }, { series: 'X' }, { year: '2099' }, { changeType: 'C' }]) {
    const result = collectNotamRecords({ records: [active] }, [changed(cancelled, fields)]);
    assert.equal(result.issues?.length, 1, JSON.stringify(fields));
  }
});

test('independent cancellation timestamps preserve fractional ordering and newer source revisions', () => {
  const issue = issues.find(i => i.id === '1791309061314000')!;
  const active = issue.variants.find(r => r.lifecycle === 'active')!;
  const cancelled = issue.variants.find(r => r.lifecycle === 'cancelled')!;
  const sourceUpdatedAt = '2026-10-06T17:51:00.000000001Z', updatedAt = Date.parse(sourceUpdatedAt);
  const preciseActive = changed(active, { sourceUpdatedAt, updatedAt });
  for (const canceledAt of ['2026-10-06T17:51:00.000Z', '2026-10-06T17:51:00.000000001Z',
    '2026-10-06T17:51:00.000000002Z', '2026-10-06T17:51:44.394Z', '2026-10-06T17:52:00.000Z']) {
    const preciseCancelled = changed(cancelled, { sourceUpdatedAt, updatedAt, canceledAt });
    for (const pair of [[preciseActive, preciseCancelled], [preciseCancelled, preciseActive]]) {
      const collection = collectNotamRecords({ records: [] }, pair);
      if (canceledAt === '2026-10-06T17:51:00.000Z') {
        assert.equal(collection.issues?.length, 1, 'an older sub-millisecond cancellation cannot withdraw this revision');
      } else {
        assert.equal(collection.issues?.length ?? 0, 0, canceledAt);
        assert.deepEqual(collection.records, [preciseCancelled]);
        assert.equal(collectNotamRecords(collection, [preciseActive]), collection, 'sparse replay cannot resurrect the notice');
      }
    }
  }
  const resolved = collectNotamRecords({ records: [] }, issue.variants);
  const later = new Date(Date.parse(cancelled.canceledAt) + 1000).toISOString();
  for (const fields of [{ sourceUpdatedAt: later, updatedAt: Date.parse(later) },
    { sequence: active.sequence + 1 }, { correction: active.correction + 1 }]) {
    const newer = changed(active, fields);
    const collection = collectNotamRecords(resolved, [newer]);
    assert.equal(collection.issues?.length ?? 0, 0);
    assert.deepEqual(collection.records, [newer], 'a newer source revision keeps its own lifecycle');
    assert.equal(collectNotamRecords(collection, issue.variants), collection, 'older cancellation replay cannot replace the newer revision');
  }
});

test('auxiliary rendering differences require a complete shared native notice', () => {
  const issue = issues.find(i => i.id === '3547032142897389')!;
  for (const [from, to] of [['!ANC', '!XXX'], ['10/052', '10/999'], ['ANC AD', 'XXX AD'],
    ['SN REMOVAL TRAINING', 'UNRELATED WORK'], ['2610060052', '2610060053'], ['2610060300', '2610060400']]) {
    const variants = issue.variants.map(record => changed(record, { translations: record.translations.map(t =>
      t.type === 'LOCAL_FORMAT' ? { ...t, text: t.text.replace(from!, to!) } : t) }));
    const result = collectNotamRecords({ records: [] }, variants);
    assert.equal(result.issues?.length, 1, `${from}: unrelated shared text cannot establish equivalence`);
  }
  const variants = issue.variants.map(record => changed(record, { translations: [...record.translations,
    { type: 'LOCAL_FORMAT', text: 'An additional contradictory local notice' }] }));
  assert.equal(collectNotamRecords({ records: [] }, variants).issues?.length, 1);
});

for (const complete of [true, false]) test(`restart reconciles records while preserving complete=${complete} and request admission`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-reconciliation-'));
  let store = new NotamStore(directory, 'production', () => now);
  // Genuine disagreement and lost evidence must remain unresolved after the
  // representation fixes; migration must not simply erase the issue list.
  const source = issues.find(i => i.id === '3547032142897389')!.variants[0]!;
  const conflicting = collectNotamRecords({ records: [] }, [source, changed(source, { text: source.text + ' EXC EMERG ACFT' })]);
  const genuine: NotamSourceIssue = { ...conflicting.issues![0]!, id: '0000000000000001',
    variants: conflicting.issues![0]!.variants.map(r => changed(r, { id: '0000000000000001', sourceId: '0000000000000001' })) };
  const overflow: NotamSourceIssue = { ...issues[0]!, id: '0000000000000002', variantsTruncated: true,
    variants: issues[0]!.variants.map(r => changed(r, { id: '0000000000000002', sourceId: '0000000000000002' })) };
  const scheduled = changed(issues.find(i => i.id === '4690820396922953')!.variants[1]!,
    { id: '0000000000000003', sourceId: '0000000000000003' });
  const conflictingSchedule = collectNotamRecords({ records: [scheduled] }, [changed(scheduled, { schedule: 'SAT SUN 1200-0300' })]).issues![0]!;
  try {
    await store.restore(); await store.reserve('bulk');
    const original = await store.publish({ schemaVersion: 2, environment: 'production', records: [],
      issues: [...issues, genuine, overflow, conflictingSchedule], complete, checkedAt: now, watermark: now,
      baselineAt: now - 3600_000, fullSyncAt: now - 3600_000 });
    const budget = await readFile(join(directory, 'budget.json'), 'utf8');
    await store.close(); store = new NotamStore(directory, 'production', () => now);
    const restored = await store.restore(); assert.ok(restored);
    assert.equal(restored.records.length, issues.length);
    assert.deepEqual(restored.issues?.map(i => i.id).sort(), [genuine.id, overflow.id, conflictingSchedule.id]);
    for (const field of ['checkedAt', 'watermark', 'baselineAt', 'fullSyncAt', 'complete'] as const) assert.equal(restored[field], original[field]);
    assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), budget);
    await store.close(); store = new NotamStore(directory, 'production', () => now);
    assert.deepEqual(await store.restore(), restored, 'the saved interpretation is stable across another restart');
    assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), budget);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('restart replaces legacy issue derivations without duplicating evidence or inventing overflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-legacy-issues-'));
  let store = new NotamStore(directory, 'production', () => now);
  const captured = issues.find(i => i.id === '2327861614608539')!;
  const legacyFixed = (record: NotamRecord): NotamRecord => {
    // Reproduce the older derivation, before EST in retained text was recognized.
    const { revision: _revision, ...facts } = { ...record, endKind: 'fixed' as const };
    return { ...facts, revision: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
  };
  const legacy = { ...captured, variants: captured.variants.map(legacyFixed) };
  const source = captured.variants[0]!;
  const genuine: NotamSourceIssue = { ...captured, id: '0000000000000001',
    variants: Array.from({ length: NOTAM_MAX_ISSUE_VARIANTS }, (_, i) => legacyFixed(changed(source, {
      id: '0000000000000001', sourceId: '0000000000000001', text: source.text + ` EXC ACFT ${i}`,
    }))) };
  const estimated = changed(source, { id: '0000000000000002', sourceId: '0000000000000002' });
  const overflow: NotamSourceIssue = { ...captured, id: estimated.id, variantsTruncated: true,
    variants: [legacyFixed(estimated), estimated] };
  assert.ok([legacy, genuine, overflow].every(isNotamSourceIssue));
  try {
    await store.restore(); await store.reserve('bulk');
    const original = await store.publish({ schemaVersion: 2, environment: 'production', records: [],
      issues: [legacy, genuine, overflow], complete: false, checkedAt: now, watermark: now,
      baselineAt: now - 3600_000, fullSyncAt: now - 3600_000 });
    const budget = await readFile(join(directory, 'budget.json'), 'utf8');
    await store.close(); store = new NotamStore(directory, 'production', () => now);
    const restored = await store.restore(); assert.ok(restored);
    assert.equal(restored.records.length, 1); assert.equal(restored.records[0]!.id, captured.id);
    assert.equal(restored.records[0]!.endKind, 'estimated');
    assert.deepEqual(restored.issues?.map(i => i.id), [genuine.id, overflow.id]);
    const retained = restored.issues![0]!, truncated = restored.issues![1]!;
    assert.equal(retained.variants.length, NOTAM_MAX_ISSUE_VARIANTS); assert.equal(retained.variantsTruncated, false);
    assert.deepEqual(new Set(retained.variants.map(r => r.text)), new Set(genuine.variants.map(r => r.text)));
    assert.ok(retained.variants.every(r => r.endKind === 'estimated'));
    assert.equal(truncated.variants.length, 1); assert.equal(truncated.variantsTruncated, true);
    assert.ok(restored.issues!.every(isNotamSourceIssue));
    for (const field of ['checkedAt', 'watermark', 'baselineAt', 'fullSyncAt', 'complete'] as const) assert.equal(restored[field], original[field]);
    assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), budget);
    await store.close(); store = new NotamStore(directory, 'production', () => now);
    assert.deepEqual(await store.restore(), restored);
    assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), budget);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('repaired source pairs survive XML delta replay, empty updates, backoff, airport caching and another restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-reconciled-service-'));
  let time = now, calls = 0, round = 0;
  const state = join(directory, 'production'), seed = new NotamStore(state, 'production', () => time);
  await seed.restore(); await seed.reserve('bulk');
  await seed.publish({ schemaVersion: 2, environment: 'production', records: [], issues,
    complete: true, checkedAt: time, watermark: time, baselineAt: time, fullSyncAt: time });
  await seed.close();
  const create = () => createNotamService({ enabled: true, environment: 'production', directory,
    credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
    signal: new AbortController().signal, now: () => time, wait: async ms => { time += ms; },
    fetch: async input => {
      calls++; time += 1001;
      const url = new URL(String(input));
      if (url.pathname === '/v1/auth/token') return Response.json({ access_token: 'fixture', expires_in: '1799' });
      assert.equal(url.pathname, '/nmsapi/v1/notams', 'repair must not consume another bulk allowance');
      round++;
      if (round === 3) return new Response('', { status: 503, headers: { 'Retry-After': '600' } });
      return Response.json({ status: 'Success', data: { aixm: round === 1
        ? issues.flatMap(issue => [...issue.variants].reverse().map(record => aixm(record))) : [] } });
    },
  });
  let service = create(), responder = createNotamResponder(service);
  const read = (location: string) => {
    const result = responder.read(`/api/notams/airports?faaId=${location}`, undefined);
    assert.equal(result.status, 200);
    const value: unknown = JSON.parse(result.body.toString()); assert.ok(isNotamAirportSnapshot(value)); return value;
  };
  const checkAirports = () => {
    assert.equal(service.status.unresolvedRecords, 0); assert.equal(service.status.collectionContinuity, 'complete');
    for (const issue of issues) for (const location of issue.locations) {
      const snapshot = read(location); assert.equal(snapshot.contentCoverage, 'complete');
      assert.equal(snapshot.issues?.length, 0);
      assert.equal(snapshot.records.some(r => r.id === issue.id), !issue.variants.some(r => r.lifecycle === 'cancelled'));
    }
  };
  try {
    await service.restore(); checkAirports(); assert.equal(calls, 0);
    time += 180_001; service.refresh(); await service.settled(); checkAirports();
    assert.equal(calls, 2); assert.equal(round, 1); assert.equal(service.status.state, 'ready');
    const generation = service.status.generation, checkedAt = service.status.checkedAt!;
    time += 180_001; service.refresh(); await service.settled(); checkAirports();
    assert.equal(service.status.generation, generation, 'empty delta reuses the immutable dataset');
    assert.ok(service.status.checkedAt! > checkedAt);
    const fresh = read(issues[0]!.locations[0]!); assert.equal(fresh.feed.checkedAt, service.status.checkedAt);
    time += 180_001; service.refresh(); await service.settled(); checkAirports();
    const failed = read(issues[0]!.locations[0]!);
    assert.equal(failed.feed.generation, fresh.feed.generation); assert.equal(failed.feed.checkedAt, fresh.feed.checkedAt);
    assert.equal(failed.feed.error, 'source-backoff'); assert.equal(failed.feed.state, 'degraded');
    const spent = calls, nextAttemptAt = service.status.nextAttemptAt, budget = await readFile(join(state, 'budget.json'), 'utf8');
    for (let i = 0; i < 100; i++) { checkAirports(); service.refresh(); }
    await service.settled(); assert.equal(calls, spent);
    await service.close(); service = create(); responder = createNotamResponder(service); await service.restore();
    checkAirports(); assert.equal(service.status.nextAttemptAt, nextAttemptAt);
    service.refresh(); await service.settled(); assert.equal(calls, spent);
    assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
