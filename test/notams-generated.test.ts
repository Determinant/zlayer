import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isNotamRecord, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import { aixm, NOTAM_NOW } from './fixtures/notams';
import { changeGeneratedNotam as changed, generatedNotams, notamRandom } from './fixtures/notams-generated';
import { permutations, batchPartitions } from './helpers/permutations';
import { createNotamXmlParser } from '../tools/info-server/notams/normalize';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { resolveNotamRevision } from '../tools/info-server/notams/revision';
import { NotamStore } from '../tools/info-server/notams/store';
import { createNotamService } from '../tools/info-server/notams/service';
import { notamEndKind, notamValidity } from '../src/layers/notams/validity';

type Collection = ReturnType<typeof collectNotamRecords>;
const cases = [...generatedNotams()];

test('ICAO estimated ends survive ingestion without a native interval and conflicting ends remain unknown', () => {
  const source = cases.find(value => value.end === 'estimated')!.full;
  const record = changed(source, { translations: source.translations.filter(t => t.type === 'OTHER:ICAO') });
  const raw = record.translations[0]!.text;
  for (const text of [raw, raw.replace('C) ', 'C)'), raw.replaceAll('EST', '&#69;&#83;&#84;'),
    `<pre>\n${raw.replaceAll(' ', '\n ')}\n</pre>`]) {
    const parsed = ingest(changed(record, { translations: [{ type: 'OTHER:ICAO', text }] }), 79302);
    assert.equal(parsed.endKind, 'estimated');
    assert.equal(notamValidity(parsed, parsed.endsAt!), 'check validity');
    assert.equal(notamEndKind({ ...parsed, endKind: 'fixed' }), 'estimated', 'saved fixed-end records still retain EST evidence');
    const contrary = { type: 'OTHER:ICAO', text: raw.replace('2610051200EST', '2610061200EST') };
    assert.equal(notamEndKind(changed(parsed, { translations: [...parsed.translations, contrary] })), 'unknown');
  }
  for (const text of ['C) 2610051200EST', 'WORK EST COMPLETE C) 2610051200EST', raw.replace(' E)', ' UNKNOWN)')]) {
    assert.equal(notamEndKind(changed(record, { endKind: 'fixed', translations: [{ type: 'OTHER:ICAO', text }] })), 'fixed');
  }
});
function* deliveries(records: NotamRecord[]) {
  for (const order of permutations(records)) for (const batches of batchPartitions(order)) {
    let result: Collection = { records: [] };
    for (const batch of batches) result = collectNotamRecords(result, batch);
    yield result;
  }
}
function checkCase(value: typeof cases[number], run: () => void) {
  try { run(); } catch (cause) {
    const { full: _full, alternate: _alternate, sparse: _sparse, ...parameters } = value;
    throw new Error(`Generated NOTAM counterexample: ${JSON.stringify(parameters)}`, { cause });
  }
}
function ingest(record: NotamRecord, seed: number): NotamRecord {
  const records: NotamRecord[] = [], random = notamRandom(seed), xml = aixm(record);
  const parser = createNotamXmlParser(value => records.push(value), { count: 1, snapshotAt: NOTAM_NOW });
  for (let offset = 0; offset < xml.length;) {
    const end = offset + 1 + random(73); parser.write(xml.slice(offset, end)); offset = end;
  }
  parser.finish(); assert.equal(records.length, 1); assert.ok(isNotamRecord(records[0])); return records[0];
}

test('seeded spec-derived notices compose through XML chunks, all orders, batches, sparse repeats and rebase', () => {
  for (const value of cases) checkCase(value, () => {
    const { full, alternate, sparse, seed, station, fir } = value;
    const input = [full, alternate, sparse].map((r, i) => ingest(r, seed + i));
    const before = JSON.stringify(input);
    for (const result of deliveries(input)) {
      assert.equal(result.issues?.length ?? 0, 0); assert.equal(result.records.length, 1);
      const record = result.records[0]!; assert.ok(isNotamRecord(record));
      assert.deepEqual(record.icaoLocations, [station, fir].sort());
      assert.deepEqual(new Set(record.sourceIcaoLocations!.flat()), new Set([station, fir]));
      assert.equal(record.year, full.year); assert.equal(record.schedule, full.schedule); assert.equal(record.endKind, full.endKind);
      assert.equal(record.updatedAt, full.updatedAt); assert.equal(record.sourceUpdatedAt, full.sourceUpdatedAt);
      assert.equal(record.text, full.text);
      for (const translation of input.flatMap(r => r.translations))
        assert.ok(record.translations.some(t => t.type === translation.type && t.text === translation.text));
      assert.equal(collectNotamRecords(result, [...input, ...input]), result);
      const rebased = rebaseNotamRecords(result, [input[2]!], NOTAM_NOW);
      assert.equal(rebased.issues?.length ?? 0, 0); assert.deepEqual(rebased.records[0]!.icaoLocations, record.icaoLocations);
    }
    assert.equal(JSON.stringify(input), before, 'evaluation leaves all source observations unchanged');
  });
});

const contradictions = [
  ['body', (r: NotamRecord) => changed(r, { text: `${r.text} EXC EMERGENCY` })],
  ['identity', (r: NotamRecord) => changed(r, { number: String(Number(r.number) + 1) })],
  ['year', (r: NotamRecord) => changed(r, { year: '2025' })],
  ['schedule', (r: NotamRecord) => changed(r, { schedule: 'DLY 1500-1700' })],
  ['interval', (r: NotamRecord) => changed(r, { effectiveStart: '202610041200', startsAt: r.startsAt! + 60_000 })],
  ['Q FIR', (r: NotamRecord) => changed(r, { translations: r.translations.map(t => t.type === 'OTHER:ICAO'
    ? { ...t, text: t.text.replace(/Q\) [A-Z]{4}/, 'Q) CZZZ') } : t) })],
  ['A FIR', (r: NotamRecord) => changed(r, { translations: r.translations.map(t => t.type === 'OTHER:ICAO'
    ? { ...t, text: t.text.replace(/A\) [A-Z]{4}/, 'A) CZZZ') } : t) })],
  ['upper limit', (r: NotamRecord) => changed(r, { translations: r.translations.map(t => t.type === 'OTHER:ICAO'
    ? { ...t, text: t.text.includes('G)') ? t.text.replace('G) FL180', 'G) FL190') : `${t.text} F) SFC G) FL190` } : t) })],
  ['unsupported rendering', (r: NotamRecord) => changed(r, { translations: [...r.translations, { type: 'OTHER:UNKNOWN', text: 'UNRECOGNIZED' }] })],
  ['third scope', (r: NotamRecord) => changed(r, { icaoLocations: ['CZZZ'] })],
] as const;

test('generated contrary third observations survive every delivery order and sparse replay while other IDs advance', () => {
  for (const value of cases) checkCase(value, () => {
    const { full, alternate, sparse, index } = value;
    const [label, mutate] = contradictions[index % contradictions.length]!;
    const contrary = mutate(full);
    const independentId = String(1900000000000000 + index);
    const independent = changed(full, { id: independentId, sourceId: `NMS_ID_${independentId}` });
    assert.ok(isNotamRecord(independent));
    for (const result of deliveries([full, alternate, contrary])) {
      assert.equal(result.records.length, 0, label); assert.equal(result.issues?.length, 1, label);
      const replayed = collectNotamRecords(result, [sparse, full, independent]);
      assert.equal(replayed.issues?.length, 1, label); assert.equal(replayed.records.length, 1, label);
      assert.equal(replayed.records[0]!.id, independent.id);
      const rebased = rebaseNotamRecords(replayed, [full, independent], NOTAM_NOW);
      assert.equal(rebased.issues?.length, 1, label);
      assert.equal(rebased.issues![0]!.variants.some(r => r.revision === contrary.revision), true, label);
    }
  });
});

test('generated original-ID cancellations cannot be undone by richer active repeats', () => {
  for (const value of cases) checkCase(value, () => {
    const { full, alternate, sparse } = value;
    const cancelled = changed(alternate, { lifecycle: 'cancelled', canceledAt: full.sourceUpdatedAt });
    for (const result of deliveries([full, sparse, cancelled])) {
      assert.equal(result.issues?.length ?? 0, 0); assert.equal(result.records[0]!.lifecycle, 'cancelled');
      assert.equal(collectNotamRecords(result, [full, alternate]).records[0]!.lifecycle, 'cancelled');
      assert.equal(result.records[0]!.sourceUpdatedAt, full.sourceUpdatedAt);
    }
  });
});

test('generated evidence restores twice with diagnostics, source clocks and admission history preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-generated-')), state = join(directory, 'production');
  const store = new NotamStore(state, 'production', () => NOTAM_NOW);
  const issues: NotamSourceIssue[] = cases.map(({ full, alternate }, index) => {
    const contrary = contradictions[5]![1](full);
    const seed = collectNotamRecords({ records: [] }, [alternate, contrary]).issues![0]!;
    return index % 2 ? { ...seed, variants: [full, alternate] } : { ...seed, variants: [alternate, contrary] };
  });
  // Reproduce old persisted derivations without calling today's normalizer,
  // which would repair them before the restore path under test sees them.
  const estimated = cases.find(value => value.end === 'estimated')!.full;
  const legacyRecords = ['estimated', 'unknown'].map((expected, index) => {
    const { revision: _revision, ...facts } = estimated;
    const id = String(1900000000000000 + index);
    const old = { ...facts, id, sourceId: `NMS_ID_${id}`, endKind: 'fixed' as const,
      translations: facts.translations.filter(t => t.type === 'OTHER:ICAO').map(t => ({ ...t,
        text: expected === 'unknown' ? t.text.replace('2610051200EST', '2610061200EST') : t.text })) };
    const record = { ...old, revision: createHash('sha256').update(JSON.stringify(old)).digest('hex') };
    assert.ok(isNotamRecord(record)); return record;
  });
  const clocks = { checkedAt: NOTAM_NOW, watermark: NOTAM_NOW, fullSyncAt: NOTAM_NOW - 600_000, baselineAt: NOTAM_NOW - 660_000 };
  try {
    await store.restore(); await store.admission.reserve('bulk');
    await store.publish({ schemaVersion: 2, environment: 'production', ...clocks, complete: true, records: legacyRecords, issues });
    const budget = await readFile(join(state, 'budget.json'), 'utf8'); await store.close();
    for (let restart = 0; restart < 2; restart++) {
      const service = createNotamService({ enabled: true, environment: 'production', directory,
        credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
        now: () => NOTAM_NOW, signal: new AbortController().signal, fetch: async () => assert.fail('Restore must not fetch'),
      });
      try {
        await service.restore();
        assert.equal(service.sourceIssues!.total, cases.length / 2);
        assert.equal(service.status.blockingRecords, cases.length / 2);
        for (const sample of service.sourceIssues!.samples) {
          const association = sample.comparisons[0]!.association;
          assert.equal(association?.outcome, 'unproven');
          assert.ok(association?.outcome === 'unproven' && association.attempts.some(a => a.reason === 'fir-mismatch'));
        }
        for (const [index, value] of cases.entries()) {
          const snapshot = service.readRegion({ firId: value.fir })!;
          assert.equal(snapshot.records.some(r => r.id === value.full.id), index % 2 === 1);
          if (index % 2) assert.equal(resolveNotamRevision([value.full, value.alternate]).kind, 'resolved');
        }
        for (const [index, old] of legacyRecords.entries()) {
          const restored = service.readRegion({ firId: old.icaoLocations[0]! })!.records.find(r => r.id === old.id)!;
          assert.ok(restored); assert.equal(restored.endKind, index ? 'unknown' : 'estimated');
          const { revision, endKind: _endKind, ...facts } = restored;
          const { revision: oldRevision, endKind: _oldEndKind, ...oldFacts } = old;
          assert.notEqual(revision, oldRevision); assert.deepEqual(facts, oldFacts);
          assert.equal(notamValidity(restored, old.endsAt!), 'check validity');
        }
        const manifest = JSON.parse(await readFile(join(state, 'current.json'), 'utf8'));
        for (const key of ['checkedAt', 'watermark', 'fullSyncAt', 'baselineAt'] as const) assert.equal(manifest[key], clocks[key]);
        assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
      } finally { await service.close(); }
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
