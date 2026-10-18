import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNotamSourceIssue, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import capture from './fixtures/notams-rkti-2026-10-11.json';
import { permutations } from './helpers/permutations';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { compareNotamContent, resolveNotamFilingScope } from '../tools/info-server/notams/revision';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { NotamStore } from '../tools/info-server/notams/store';
import { NotamIndex } from '../tools/info-server/notams/index';
import { createNotamService } from '../tools/info-server/notams/service';

const captured: unknown = capture.issues[0]; assert.ok(isNotamSourceIssue(captured));
const source = captured.variants[0]!;
const changed = (record: NotamRecord, fields: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = { ...record, ...fields }; return recordWithRevision(facts);
};
// Invented standards-based variants of the captured envelope; not additional
// observed NMS corrections. Each body, identity and interval binds to its record.
const variant = (body: string, code = 'QMRLC', purpose = 'NBO') => changed(source, {
  text: body, translations: [{ type: 'OTHER:ICAO', text: 'M0398/26 NOTAMN ' +
    `Q) RKRR/${code}/IV/${purpose}/A/000/999/3702N12753E005 ` +
    `A) RKTI B) 2610162300 C) 2610170900 E) ${body}` }],
});
const translated = (record: NotamRecord, fn: (text: string) => string) => changed(record, {
  translations: record.translations.map(t => ({ ...t, text: fn(t.text) })),
});
function assertMerged(records: NotamRecord[], proof: string) {
  const result = collectNotamRecords({ records: [] }, records);
  assert.equal(result.issues?.length ?? 0, 0); assert.equal(result.records.length, 1);
  assert.equal(compareNotamContent(result.records[0]!, records[0]!).text.proof, proof);
  assert.deepEqual(new Set(result.records[0]!.translations.map(t => t.text)),
    new Set(records.flatMap(record => record.translations.map(t => t.text))));
  assert.equal(result.records[0]!.updatedAt, source.updatedAt);
  assert.equal(collectNotamRecords(result, [...records, changed(result.records[0]!, { translations: [] })]), result);
  assert.equal(rebaseNotamRecords(result, records.slice(0, 1), capture.checkedAt).issues?.length ?? 0, 0);
  return result;
}

test('FAA closure subjects and OPADD QXXXX correction require a complete statement and an agreeing supplied code', () => {
  const examples = [
    ['AD CLSD', 'QFALC'], ['APRON CLSD', 'QMNLC'], ['APRON A1 CLSD DUE TO WIP', 'QMNLC'],
    ['RWY 09/27 CLSD', 'QMRLC'], ['TWY A1 CLSD DUE TO WIP', 'QMXLC'],
  ];
  for (const [body, code] of examples) for (const other of ['QFALC', 'QMNLC', 'QMRLC', 'QMXLC', 'QXXXX']) {
    if (other === code) continue;
    for (const order of permutations([variant(body!, code), variant(body!, other)])) assertMerged(order, 'icao-selection-code');
  }
  for (const body of ['AD CLSD EXC MIL', 'AD MAY BE CLSD', 'APRON A/B CLSD', 'APRON A CLSD TWY B OPEN',
    'RWY 00 CLSD', 'RWY 37 CLSD', 'RWY 09 CLSD DUE TO WEATHER', 'TWY CLSD', 'RWY 09 NOT CLSD',
    'NOTAM SUBJECT TO QUERY RWY 09 CLSD', 'APRON PARTLY CLSD', 'TWY PARTLY CLSD', 'TWY TEMPO CLSD']) {
    assert.equal(collectNotamRecords({ records: [] }, [variant(body), variant(body, 'QXXXX')]).issues?.length, 1, body);
  }
  const wrong = [variant('RWY 09 CLSD', 'QMXLC'), variant('RWY 09 CLSD', 'QXXXX')];
  assert.equal(collectNotamRecords({ records: [] }, wrong).issues?.length, 1, 'neither retained code agrees with E');
});

test('OPADD purpose upgrades retain the highest supplied purpose in every arrival order and sparse replay', () => {
  const records = ['M', 'B', 'BO', 'NBO'].map(purpose => variant('RWY 09 CLSD', 'QMRLC', purpose));
  for (const order of permutations(records)) {
    const result = assertMerged(order, 'icao-purpose-upgrade');
    assert.ok(result.records[0]!.translations.some(t => t.text.includes('/NBO/')));
    assert.equal(collectNotamRecords(result, [records[0]!]), result, 'later M cannot remove the retained NBO evidence');
  }
  // Purpose qualification does not reinterpret the E or F/G content.
  const body = 'CRANE 1500FT MSL F) SFC G) 2000FT MSL';
  assertMerged([variant(body, 'QOBCE', 'BO'), variant(body, 'QOBCE', 'NBO')], 'icao-purpose-upgrade');
});

test('code correction and purpose upgrading compose with formatting and distribution evidence without losing raw variants', () => {
  const original = variant('AD CLSD', 'QFALC', 'M');
  const corrected = translated(variant('AD CLSD', 'QXXXX', 'NBO'), text =>
    `<pre>${text.replace(/([A-GQ]\))\s*/g, '$1')} UNITED STATES NOF DISCLAIMS FOREIGN NOTAM ACCURACY OR COMPLETENESS</pre>`);
  const intermediate = variant('AD CLSD', 'QMNLC', 'BO');
  for (const order of permutations([original, corrected, intermediate])) assertMerged(order, 'icao-qualification');
});

test('a confirming third variant resolves a provisional conflict independently of digest and delivery order', () => {
  const wrong = [variant('AD CLSD', 'QXXXX', 'NBO'), variant('AD CLSD', 'QMNLC', 'BO')];
  // Force both nonconfirming variants ahead of the confirming witness in the
  // collection's stable digest order. Publication metadata is not precedence.
  let confirming = variant('AD CLSD', 'QFALC', 'M');
  for (let i = 0; wrong.some(record => record.revision > confirming.revision) && i < 1000; i++) {
    confirming = changed(confirming, { issuedAt: source.issuedAt! + i });
  }
  assert.ok(wrong.every(record => record.revision < confirming.revision));
  for (const order of permutations([...wrong, confirming])) {
    const together = assertMerged(order, 'icao-qualification');
    let sequential = collectNotamRecords({ records: [] }, []);
    for (const record of order) sequential = collectNotamRecords(sequential, [record]);
    assert.equal(sequential.issues?.length ?? 0, 0);
    assert.deepEqual(new Set(sequential.records[0]!.translations.map(t => t.text)),
      new Set(together.records[0]!.translations.map(t => t.text)));
  }
});

test('filing-scope recovery uses the complete qualification evidence while retaining disputed associations', async () => {
  const wrong = [changed(variant('AD CLSD', 'QXXXX', 'NBO'), { icaoLocations: ['RKTI', 'RKAA'] }),
    changed(variant('AD CLSD', 'QMNLC', 'BO'), { icaoLocations: ['RKTI', 'RKBB'] })];
  let confirming = changed(variant('AD CLSD', 'QFALC', 'M'), { icaoLocations: ['RKTI', 'RKCC'] });
  // Put the missing witness last in the actual collection's digest order too.
  for (let i = 0; wrong.some(record => record.revision > confirming.revision) && i < 1000; i++) {
    confirming = changed(confirming, { issuedAt: source.issuedAt! + i });
  }
  assert.ok(wrong.every(record => record.revision < confirming.revision));
  const variants = [...wrong, confirming], collection = collectNotamRecords({ records: [] }, variants);
  const issue = collection.issues![0]!;
  assert.ok(isNotamSourceIssue(issue));
  const originals = JSON.stringify(issue);
  for (const order of permutations(variants)) {
    const projected = resolveNotamFilingScope({ ...issue, variants: order });
    assert.ok(projected, 'a later confirming witness must resolve the earlier pair');
    assert.deepEqual(projected.locations, source.locations);
    assert.deepEqual(projected.icaoLocations, ['RKTI']);
    assert.deepEqual(new Set(projected.icaoLocationVariants!.flat()), new Set(['RKTI', 'RKAA', 'RKBB', 'RKCC']));
    assert.deepEqual(new Set(projected.translations.map(t => t.text)), new Set(variants.flatMap(r => r.translations.map(t => t.text))));
    assert.equal(projected.updatedAt, source.updatedAt);
  }
  const index = new NotamIndex(() => capture.checkedAt);
  index.publish({ ...collection, schemaVersion: 2, environment: 'production', generation: 'fixture',
    complete: true, checkedAt: capture.checkedAt, watermark: capture.checkedAt, baselineAt: capture.checkedAt, fullSyncAt: capture.checkedAt });
  assert.equal(index.read('RKTI').records.length, 1);
  assert.deepEqual(index.read('RKTI').issues, []);
  assert.equal(index.sourceIssues.associationOnly, 1);
  assert.equal(index.sourceIssues.blocking, 1, 'the disputed ICAO queries still qualify readiness');
  for (const icaoId of ['RKAA', 'RKBB', 'RKCC']) {
    assert.deepEqual(index.read(undefined, icaoId), { records: [], issues: [issue] });
  }
  assert.equal(resolveNotamFilingScope({ ...issue, variantsTruncated: true }), undefined);
  assert.equal(resolveNotamFilingScope({ ...issue, variants: wrong }), undefined, 'no supplied code proves the closure subject');
  assert.equal(resolveNotamFilingScope({ ...issue, variants: [...wrong, changed(confirming, { text: 'AD OPEN' })] }), undefined);
  assert.equal(resolveNotamFilingScope({ ...issue, variants: [...wrong, changed(confirming, {
    updatedAt: confirming.updatedAt + 1000, sourceUpdatedAt: new Date(confirming.updatedAt + 1000).toISOString(),
  })] }), undefined, 'a projection cannot cross source revisions');
  assert.equal(JSON.stringify(issue), originals, 'projection must not rewrite retained source evidence');

  const directory = await mkdtemp(join(tmpdir(), 'notam-filing-qualification-')), state = join(directory, 'production');
  const now = capture.checkedAt, store = new NotamStore(state, 'production', () => now);
  try {
    await store.restore(); await store.admission.reserve('bulk');
    await store.publish({ ...collection, schemaVersion: 2, environment: 'production', complete: true,
      checkedAt: now, watermark: now, baselineAt: now, fullSyncAt: now });
    const budget = await readFile(join(state, 'budget.json'), 'utf8'); await store.close();
    const service = createNotamService({ enabled: true, environment: 'production', directory,
      credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
      signal: new AbortController().signal, now: () => now, fetch: async () => assert.fail('Restore must not fetch'),
    });
    try {
      await service.restore();
      assert.equal(service.readAirport({ icaoId: 'RKTI' })!.contentCoverage, 'complete');
      assert.equal(service.readAirport({ icaoId: 'RKTI' })!.records.length, 1);
      assert.deepEqual(service.readAirport({ icaoId: 'RKAA' })!.issues, [issue]);
      for (const clock of ['checkedAt', 'watermark', 'fullSyncAt'] as const) assert.equal(service.status[clock], now);
      assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
    } finally { await service.close(); }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('qualification does not erase other supplied fields, unknown purpose values, incomplete evidence or a third contradiction', () => {
  const a = variant('RWY 09 CLSD', 'QMRLC', 'BO'), b = variant('RWY 09 CLSD', 'QXXXX', 'NBO');
  const good = collectNotamRecords({ records: [] }, [a, b]);
  const bad = [
    ...['K', 'N', 'O', 'NB', 'BOGUS', ''].map(purpose => variant('RWY 09 CLSD', 'QXXXX', purpose)),
    ...['QMRLT', 'QZZLC'].map(code => variant('RWY 09 CLSD', code)),
    ...[['RKRR/', 'RJJJ/'], ['/IV/', '/I/'], ['/A/', '/E/'], ['/000/', '/010/'], ['/999/', '/100/'],
      ['3702N', '3703N'], ['12753E005', '12753E006'], ['A) RKTI', 'A) RKTA'], ['M0398/26', 'M0399/26'],
      ['2610170900', '2610171000'], [' E)', ' D) DAILY 0800-0900 E)'], [' E)', ' E) EXC MIL'],
      [' C) 2610170900', ''], ['NOTAMN', 'NOTAMR M0397/26']].map(([from, to]) => translated(b, text => text.replace(from!, to!))),
    changed(b, { text: 'RWY 09 CLSD EXC MIL' }),
    changed(b, { translations: [...b.translations, { type: 'OTHER:ICAO', text: 'UNKNOWN' }] }),
  ];
  for (const variant of bad) {
    for (const order of [[a, variant], [variant, a]]) {
      assert.equal(collectNotamRecords({ records: [] }, order).issues?.length, 1, JSON.stringify(variant.translations));
    }
    const disputed = collectNotamRecords(good, [variant]);
    assert.equal(disputed.issues?.length, 1);
    assert.equal(collectNotamRecords(disputed, [a]).issues?.length, 1, 'a sparse repeat cannot erase the third variant');
  }
  for (const pair of [
    [a, b].map(record => changed(record, { year: '2027' })),
    [a, b].map(record => translated(changed(record, { text: record.text + ' F) SFC G) 1000FT MSL' }), text => text + ' F) SFC G) 1000FT MSL')),
  ]) assert.equal(collectNotamRecords({ records: [] }, pair).issues?.length, 1);
  const purposeOnly = [variant('RWY 09 CLSD', 'QMRLC', 'M'), variant('RWY 09 CLSD', 'QMRLC', 'NBO')];
  assert.equal(collectNotamRecords({ records: [] }, purposeOnly.map(record => changed(record, { year: '2027' }))).issues?.length, 1);
  const vertical = [variant('CRANE F) SFC G) FL100', 'QOBCE', 'BO'), variant('CRANE F) SFC G) FL110', 'QOBCE', 'NBO')];
  assert.equal(collectNotamRecords({ records: [] }, vertical).issues?.length, 1);
});

test('authenticated restart replays qualified issues and preserves contradictions, admission history and source clocks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-qualification-')), state = join(directory, 'production');
  const variants = [variant('AD CLSD', 'QFALC', 'M'), variant('AD CLSD', 'QXXXX', 'NBO')];
  const issue: NotamSourceIssue = { ...captured, variants };
  const badVariants = variants.map((record, i) => changed(record, { id: '1791683227547001', sourceId: 'NMS_ID_1791683227547001',
    ...(i ? { text: 'AD OPEN' } : {}) }));
  const bad = collectNotamRecords({ records: [] }, badVariants).issues![0]!;
  const now = capture.checkedAt, store = new NotamStore(state, 'production', () => now);
  try {
    await store.restore(); await store.admission.reserve('bulk');
    await store.publish({ schemaVersion: 2, environment: 'production', records: [], issues: [issue, bad],
      complete: true, checkedAt: now, watermark: now, fullSyncAt: now, baselineAt: now });
    const budget = await readFile(join(state, 'budget.json'), 'utf8'); await store.close();
    for (let restart = 0; restart < 2; restart++) {
      const service = createNotamService({ enabled: true, environment: 'production', directory,
        credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
        now: () => now, signal: new AbortController().signal, fetch: async () => assert.fail('Offline restore must not fetch'),
      });
      try {
        await service.restore();
        const airport = service.readAirport({ icaoId: 'RKTI' })!;
        assert.equal(airport.records.length, 1); assert.deepEqual(airport.issues, [bad]);
        assert.deepEqual(new Set(airport.records[0]!.translations.map(t => t.text)), new Set(variants.flatMap(record => record.translations.map(t => t.text))));
        assert.equal(service.status.blockingRecords, 1); assert.equal(service.status.collectionContinuity, 'complete');
        for (const clock of ['checkedAt', 'watermark', 'fullSyncAt'] as const) assert.equal(service.status[clock], now);
        assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
      } finally { await service.close(); }
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
