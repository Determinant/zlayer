import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNotamRecord, isNotamSourceIssue, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import capture from './fixtures/notams-state-2026-10-16.json';
import fdc from './fixtures/notams-fdc-renderings.json';
import intl from './fixtures/notams-rkti-2026-10-11.json';
import johCapture from './fixtures/notams-evidence-2026-10-08.json';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { compareNotamContent, resolveNotamRevision, resolveNotamFilingScope } from '../tools/info-server/notams/revision';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { NotamStore } from '../tools/info-server/notams/store';
import { createInfoServer } from '../tools/info-server/server';
import { permutations, batchPartitions } from './helpers/permutations';

const issues = capture.issues.map(value => { assert.ok(isNotamSourceIssue(value)); return value; });
type NotamCollection = ReturnType<typeof collectNotamRecords>;
const changed = (record: NotamRecord, patch: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = record; return recordWithRevision({ ...facts, ...patch });
};
function assertResolved(variants: NotamRecord[]) {
  let result: NotamCollection = { records: [] };
  for (const order of permutations(variants)) for (const batches of batchPartitions(order)) {
    let collection: NotamCollection = { records: [] };
    for (const batch of batches) collection = collectNotamRecords(collection, batch);
    assert.equal(collection.issues?.length ?? 0, 0); assert.equal(collection.records.length, 1);
    assert.ok(isNotamRecord(collection.records[0]));
    assert.equal(collection.records[0]!.updatedAt, variants[0]!.updatedAt);
    for (const translation of variants.flatMap(v => v.translations))
      assert.ok(collection.records[0]!.translations.some(t => t.type === translation.type && t.text === translation.text));
    assert.equal(collectNotamRecords(collection, [...order, ...order]), collection);
    assert.equal(rebaseNotamRecords(collection, [variants[0]!], variants[0]!.updatedAt).issues?.length ?? 0, 0);
    result = collection;
  }
  return result.records[0]!;
}

// Deliberately invented omissions of captured notices, not additional observed
// source variants. Live aggregate replay separately qualifies the real cohort.
const domestic = issues[1]!.variants[0]!;
const international = intl.issues[0]!.variants[0]! as NotamRecord;
const yearCases = [domestic, fdc.pairs[0]!.previous as NotamRecord, international,
  changed(international, { classification: 'MIL' })];

test('a numbering year supplements only a witnessed omission across domestic, FDC, INTL and MIL profiles', () => {
  for (const record of yearCases) {
    const missing = changed(record, { year: '' });
    const result = assertResolved([record, missing, changed(missing, { translations: [] })]);
    assert.equal(result.year, record.year); assert.deepEqual(result.sourceYears, ['', record.year]);
    assert.ok(resolveNotamRevision([record, missing]).kind === 'resolved');
    assert.ok(compareNotamContent(record, missing).evidence.includes('source-year-omission'));
    const alternateTime = changed(missing, { sourceUpdatedAt: missing.sourceUpdatedAt.replace('.000Z', 'Z') });
    assert.equal(resolveNotamRevision([record, alternateTime]).kind, 'resolved');
    assert.equal(isNotamRecord({ ...result, sourceYears: ['', '2025'] }), false);
    assert.equal(isNotamRecord({ ...result, sourceYears: [record.year, record.year] }), false);
  }
  const a = fdc.pairs[0]!.previous as NotamRecord, b = changed(fdc.pairs[0]!.next as NotamRecord, { year: '' });
  const result = assertResolved([a, b]);
  assert.equal(result.year, a.year, 'the native witness can also prove the documented FDC body wrapper');
});

test('populated years, incomplete witnesses, changed operational facts and contradictory third variants stay unresolved', () => {
  for (const record of yearCases) {
    const missing = changed(record, { year: '' });
    const mutations = [
      changed(record, { year: '26' }),
      changed(record, { text: `${record.text} EXC EMERGENCY` }),
      changed(record, { locations: ['XXX'] }), changed(record, { effectiveEnd: '202710170900', endsAt: record.endsAt! + 86400_000 }),
      changed(record, { lifecycle: 'unknown' }),
      changed(record, { translations: record.translations.map(t => ({ ...t, text: t.text.replace(/26/g, '25') })) }),
    ];
    for (const mutation of mutations) for (const order of [[missing, mutation], [mutation, missing]])
      assert.equal(resolveNotamRevision(order).kind, 'unresolved');
    assert.equal(resolveNotamRevision([missing, record].map(r => changed(r, { translations: [] }))).kind, 'unresolved',
      'at least one complete identity witness is required');
    const contrary = changed(record, { year: '2025' });
    for (const order of [[record, contrary], [contrary, record]]) assert.equal(resolveNotamRevision(order).kind, 'unresolved');
    for (const order of permutations([record, missing, contrary])) for (const batches of batchPartitions(order)) {
      let collection: NotamCollection = { records: [] };
      for (const batch of batches) collection = collectNotamRecords(collection, batch);
      assert.equal(collection.records.length, 0); assert.equal(collection.issues?.length, 1);
      assert.equal(collectNotamRecords(collection, [missing]).issues?.length, 1);
    }
  }
});

test('captured station and FIR scopes compose without asserting an airport alias or losing their supplied sets', () => {
  for (const issue of issues.slice(1)) {
    const result = assertResolved(issue.variants);
    assert.deepEqual(result.icaoLocations, [...issue.icaoLocations].sort());
    assert.deepEqual(new Set(result.sourceIcaoLocations!.flat()), new Set(issue.icaoLocations));
    assert.equal(result.icaoLocationVariants, undefined);
    const sparse = changed(issue.variants[0]!, { translations: [] });
    assert.equal(collectNotamRecords({ records: [result] }, [sparse]).issues?.length ?? 0, 0);
    assert.equal(isNotamRecord({ ...result, sourceIcaoLocations: [issue.variants[0]!.icaoLocations, issue.variants[0]!.icaoLocations] }), false);
    assert.equal(isNotamRecord({ ...result, icaoLocations: [issue.icaoLocations[0]!] }), false);
  }
});

test('complementary scope evidence never unions arbitrary airport disputes or inconsistent FIR conversions', () => {
  for (const issue of issues.slice(1)) {
    const [a, b] = issue.variants as [NotamRecord, NotamRecord];
    const mutations = [
      changed(b, { icaoLocations: ['KXYZ'] }), changed(b, { locations: ['XXX'] }),
      changed(b, { translations: [] }), changed(b, { changeType: 'R' }),
      changed(b, { text: `${b.text} EXC EMERGENCY` }),
      changed(b, { translations: b.translations.map(t => ({ ...t, text: t.text.replace('2610151830', '2610151831').replace('2610171300', '2610171301') })) }),
      changed(b, { translations: [...b.translations, { type: 'OTHER:UNKNOWN', text: 'unqualified location' }] }),
    ];
    for (const mutation of mutations) for (const order of [[a, mutation], [mutation, a]])
      assert.equal(resolveNotamRevision(order).kind, 'unresolved');
    const wrongFir = changed(a, { icaoLocations: ['KZNY'], translations: a.translations.map(t => ({ ...t,
      text: t.text.replace(/KZHU|KZAU/g, 'KZNY').replace('Q)ZAU/', 'Q)ZNY/') })) });
    for (const order of permutations([a, b, wrongFir])) {
      assert.equal(resolveNotamRevision(order).kind, 'unresolved');
      const collection = collectNotamRecords({ records: [] }, order);
      assert.equal(collectNotamRecords(collection, [a]).issues?.length, 1);
    }
    const agreed = collectNotamRecords({ records: [] }, [a, b]);
    const disputed = collectNotamRecords(agreed, [wrongFir]);
    assert.equal(disputed.issues?.length, 1);
    assert.ok(resolveNotamFilingScope(disputed.issues![0]!), 'retained complementary scopes do not prevent the conservative filing-scope fallback');
  }
  const joh = johCapture.issues.find(issue => issue.locations.includes('JOH'));
  assert.ok(joh && isNotamSourceIssue(joh));
  assert.equal(resolveNotamRevision(joh.variants).kind, 'unresolved', 'PJOH/PACV is still a genuine airport-association conflict');
});

test('raw whitespace variants survive merging and overflow stays explicit', () => {
  const variants = Array.from({ length: 9 }, (_, i) => changed(international, {
    translations: international.translations.map(t => ({ ...t, text: `${' '.repeat(i)}${t.text}` })),
  }));
  const result = assertResolved(variants.slice(0, 3));
  assert.equal(result.translations.length, 3);
  for (const order of [variants, [...variants].reverse()]) {
    const result = collectNotamRecords({ records: [] }, order);
    assert.equal(result.records.length, 0); assert.equal(result.issues?.length, 1);
    assert.equal(result.issues?.[0]?.variantsTruncated, true);
  }
});

test('authenticated restore clears qualified issues, serves every retained scope, and preserves clocks and admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-omission-scopes-')), state = join(directory, 'production');
  const at = Date.parse(capture.capturedAt);
  const yearIssues: NotamSourceIssue[] = yearCases.slice(0, 3).map((record, i) => {
    // Give invented records distinct source IDs for this combined fixture.
    const id = `999999999999990${i}`;
    const a = changed(record, { id, sourceId: `NMS_ID_${id}` }), b = changed(a, { year: '' });
    return { id, reason: 'revision-conflict', variants: [a, b], variantsTruncated: false,
      locations: a.locations, icaoLocations: a.icaoLocations, unscoped: false };
  });
  const retained = [...issues.slice(1), ...yearIssues];
  const store = new NotamStore(state, 'production', () => at);
  await store.restore(); await store.admission.reserve('bulk');
  await store.publish({ schemaVersion: 2, environment: 'production', records: [], issues: retained,
    complete: true, checkedAt: at, watermark: at, fullSyncAt: at, baselineAt: at });
  const budget = await readFile(join(state, 'budget.json')); await store.close();
  let requests = 0;
  const app = await createInfoServer({ directory: join(directory, 'weather'), startUpdates: false, notams: { enabled: true, environment: 'production', directory,
    credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, now: () => at, fetch: async () => { requests++; throw Error('Source forbidden'); } });
  try {
    await app.notams.restore();
    assert.equal(app.notams.status.state, 'ready'); assert.equal(app.notams.status.unresolvedRecords, 0);
    assert.equal(app.notams.status.checkedAt, at); assert.equal(app.notams.status.watermark, at); assert.equal(app.notams.status.fullSyncAt, at);
    for (const issue of issues.slice(1)) {
      const station = app.notams.readNavaid({ navaidId: issue.locations[0]! })!;
      assert.ok(station.records.some(r => r.id === issue.id)); assert.deepEqual(station.issues, []);
      for (const code of issue.icaoLocations) {
        const snapshot = code.startsWith('KZ') ? app.notams.readRegion({ firId: code })! : app.notams.readAirport({ icaoId: code })!;
        assert.ok(snapshot.records.some(r => r.id === issue.id)); assert.deepEqual(snapshot.issues, []);
      }
    }
    assert.equal(requests, 0); assert.deepEqual(await readFile(join(state, 'budget.json')), budget);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
