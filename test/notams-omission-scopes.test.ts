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
import fimCapture from './fixtures/notams-fim-association-2026-10-22.json';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { compareNotamContent, resolveNotamRevision, resolveNotamFilingScope } from '../tools/info-server/notams/revision';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { NotamStore } from '../tools/info-server/notams/store';
import { createInfoServer } from '../tools/info-server/server';
import { permutations, batchPartitions } from './helpers/permutations';

const issues = capture.issues.map(value => { assert.ok(isNotamSourceIssue(value)); return value; });
const fim: NotamSourceIssue = (() => { const value: unknown = fimCapture.issues[0]; assert.ok(isNotamSourceIssue(value)); return value; })();
type NotamCollection = ReturnType<typeof collectNotamRecords>;
const changed = (record: NotamRecord, patch: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = record; return recordWithRevision({ ...facts, ...patch });
};
const paddedNative = (record: NotamRecord) => changed(record, { number: record.number.padStart(5, '0'),
  translations: record.translations.map(t => t.type === 'LOCAL_FORMAT' ? { ...t,
    text: t.text.replace(/(!\w+ \d{2}\/)(\d+)/, (_, prefix, number: string) => prefix + number.padStart(5, '0')) } : t) });
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
  for (const issue of [...issues.slice(1), fim]) {
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

test('native header padding composes with station/FIR roles and survives every retained rendering', () => {
  for (const issue of [...issues.slice(1), fim]) {
    const [a, b] = issue.variants as [NotamRecord, NotamRecord], padded = paddedNative(b);
    assert.deepEqual(assertResolved([a, b, padded]).icaoLocations, [...issue.icaoLocations].sort());
    const wrongMonth = changed(padded, { translations: padded.translations.map(t => t.type === 'LOCAL_FORMAT'
      ? { ...t, text: t.text.replace('10/', '11/') } : t) });
    for (const order of permutations([a, padded, wrongMonth])) assert.equal(resolveNotamRevision(order).kind, 'unresolved');
  }
});

test('international native headers cannot supply a domestic number or witness an omitted year', () => {
  const base = changed(fim.variants[1]!, { number: '26', icaoLocations: [], translations: [{ type: 'LOCAL_FORMAT',
    text: '!HHR A0125/26 FIM COM VOR VOICE 122.1 DECOMMISSIONED 2610222034-PERM' }] });
  const missing = changed(base, { year: '', translations: [] });
  for (const order of permutations([base, missing])) assert.equal(resolveNotamRevision(order).kind, 'unresolved');
});

// Constructed combinations of independent representation dimensions, not new
// source captures. Identity, original body and supplied scope union are the oracle.
function scopePair({ header = 'domestic', location = 'FIM', end = 'PERM', keyword = 'COM', omitKeyword = true,
  stationPrefix = false, compact = false, year = '' } = {}): NotamRecord[] {
  const base = fim.variants[1]!, start = '2610222034', body = `${keyword} VOR VOICE 122.1 DECOMMISSIONED`;
  const text = `!HHR 10/125 FIM ${body} ${start}-${end}`;
  const conversion = `${header === 'domestic' ? '10/125' : 'A0125/26'} NOTAMN ` +
    `Q) KZLA/QCAAW/IV/B/AE/000/999/3421N11852W025 A) ${location} B) ${start} C) ${end} E) ` +
    (stationPrefix ? 'FIM ' : '') + (omitKeyword ? body.slice(keyword.length + 1) : body);
  const common = { text: body, endsAt: end === 'PERM' ? null : Date.parse('2026-10-23T20:34:00Z'),
    effectiveEnd: end === 'PERM' ? end : '20' + end.replace('EST', ''),
    endKind: end === 'PERM' ? 'permanent' as const : end.endsWith('EST') ? 'estimated' as const : 'fixed' as const };
  return [changed(base, { ...common, year, icaoLocations: ['KZLA'], translations: [{ type: 'LOCAL_FORMAT', text }] }),
    changed(base, { ...common, translations: [{ type: 'LOCAL_FORMAT', text }, { type: 'OTHER:ICAO',
      text: compact ? `<pre>\n${conversion.replace(/([QA-G]\)) /g, '$1').replaceAll(' ', '\n')}\n</pre>` : conversion }] })];
}

test('station/FIR membership composes across headers, A-field roles, validity, body wrappers and whitespace', () => {
  for (const header of ['domestic', 'international']) for (const location of ['FIM', 'KFIM', 'KZLA'])
    for (const end of ['PERM', '2610232034', '2610232034EST']) for (const keyword of ['COM', 'NAV'])
      for (const omitKeyword of [false, true]) for (const stationPrefix of [false, true]) for (const compact of [false, true]) {
        const options = { header, location, end, keyword, omitKeyword, stationPrefix, compact };
        try {
          const pair = scopePair(options), result = assertResolved(pair);
          assert.deepEqual(result.icaoLocations, ['KFIM', 'KZLA']);
          assert.deepEqual(result.sourceIcaoLocations, [['KFIM'], ['KZLA']]);
          assert.equal(result.text, pair[0]!.text);
          assert.equal(result.endKind, pair[0]!.endKind);
        } catch (cause) { throw new Error(JSON.stringify(options), { cause }); }
      }
});

test('only a recognized leading keyword may be omitted, with the entire native body retained', () => {
  for (const keyword of ['RWY', 'TWY', 'APRON', 'AD', 'OBST', 'NAV', 'COM', 'SVC', 'AIRSPACE', 'ODP',
    'SID', 'STAR', 'CHART', 'DATA', 'DVA', 'IAP', 'VFP', 'ROUTE', 'SPECIAL', 'SECURITY']) {
    const pair = scopePair({ keyword });
    assert.equal(assertResolved(pair).text, pair[0]!.text);
  }
  assert.equal(resolveNotamRevision(scopePair({ keyword: 'UNKNOWN' })).kind, 'unresolved');
  assert.equal(resolveNotamRevision(scopePair({ keyword: 'UNKNOWN', omitKeyword: false })).kind, 'resolved',
    'opaque operational prose needs no subject parser when the whole bodies agree');
  const missing = scopePair().map(record => changed(record, { year: '' }));
  assert.equal(assertResolved(missing).year, '', 'a domestic header cannot manufacture a numbering year');
  const international = scopePair({ header: 'international' }).map(record => changed(record, { year: '' }));
  assert.equal(resolveNotamRevision(international).kind, 'unresolved', 'an international header needs a supplied numbering year');
  const unbound = international.map(record => changed(record, { number: '26', translations: record.translations.map(t => ({
    ...t, text: t.text.replace('10/125', 'A0125/26'),
  })) }));
  assert.equal(resolveNotamRevision(unbound).kind, 'unresolved', 'an international native header is not a domestic month/number');
});

test('complementary scopes reject changed identity, body, validity, FIR and unsupported third evidence', () => {
  const [a, b] = scopePair() as [NotamRecord, NotamRecord];
  const conversion = (from: string, to: string) => changed(b, { translations: b.translations.map(t =>
    t.type === 'OTHER:ICAO' ? { ...t, text: t.text.replace(from, to) } : t) });
  const contrary = [
    conversion('10/125', '10/126'), conversion('10/125', '11/125'), conversion('KZLA/', 'KZOA/'),
    conversion('A) FIM', 'A) LAX'), conversion('B) 2610222034', 'B) 2610222035'),
    conversion('C) PERM', 'C) 2610232034'), conversion('122.1', '122.2'),
    conversion('DECOMMISSIONED', 'U/S'), conversion('E)', 'D) DLY 2000-2100 E)'),
    conversion('E)', 'E) UNKNOWN'), conversion('DECOMMISSIONED', 'DECOMMISSIONED F) SFC'),
    conversion('NOTAMN', 'NOTAMR'), conversion('NOTAMN', 'NOTAMC'),
    changed(b, { year: '2025' }), changed(b, { icaoLocations: ['KLAX'] }),
    changed(b, { icaoLocations: ['KZOA'] }), changed(b, { locations: ['LAX'] }),
    changed(b, { text: b.text + ' EXC EMERGENCY' }),
    changed(b, { translations: [...b.translations, { type: 'OTHER:UNKNOWN', text: b.text }] }),
    changed(b, { translations: [...b.translations, { type: 'OTHER:ICAO', text: 'INCOMPLETE' }] }),
  ];
  for (const mutation of contrary) for (const order of permutations([a, b, mutation])) for (const batches of batchPartitions(order)) {
    let state: NotamCollection = { records: [] };
    for (const batch of batches) state = collectNotamRecords(state, batch);
    assert.equal(state.issues?.length, 1, JSON.stringify(mutation));
    assert.equal(collectNotamRecords(state, [a, b]).issues?.length, 1);
  }
  const noNative = scopePair().map(record => changed(record, { year: '2026',
    translations: record.translations.filter(t => t.type !== 'LOCAL_FORMAT') }));
  assert.equal(resolveNotamRevision(noNative).kind, 'unresolved');
  const truncated = collectNotamRecords({ records: [], issues: [{ ...fim, variantsTruncated: true }] }, fim.variants);
  assert.equal(truncated.issues?.length, 1);
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

for (const fixture of [
  { name: 'LSU/VIO and omitted years', at: Date.parse(capture.capturedAt), scopes: issues.slice(1), years: yearCases.slice(0, 3) },
  { name: 'FIM', at: fimCapture.checkedAt, scopes: [fim], years: [] },
  { name: 'FIM native padding', at: fimCapture.checkedAt, scopes: [{ ...fim, variants: [...fim.variants, paddedNative(fim.variants[1]!)] }], years: [] },
]) test(`authenticated restore clears ${fixture.name}, serves every retained scope, and preserves clocks and admission`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-omission-scopes-')), state = join(directory, 'production');
  const at = fixture.at;
  const yearIssues: NotamSourceIssue[] = fixture.years.map((record, i) => {
    // Give invented records distinct source IDs for this combined fixture.
    const id = `999999999999990${i}`;
    const a = changed(record, { id, sourceId: `NMS_ID_${id}` }), b = changed(a, { year: '' });
    return { id, reason: 'revision-conflict', variants: [a, b], variantsTruncated: false,
      locations: a.locations, icaoLocations: a.icaoLocations, unscoped: false };
  });
  const retained = [...fixture.scopes, ...yearIssues];
  const store = new NotamStore(state, 'production', () => at);
  await store.restore(); await store.admission.reserve('bulk');
  await store.publish({ schemaVersion: 2, environment: 'production', records: [], issues: retained,
    complete: true, checkedAt: at, watermark: at, fullSyncAt: at, baselineAt: at });
  const budget = await readFile(join(state, 'budget.json')); await store.close();
  let requests = 0;
  try {
    for (let restart = 0; restart < 2; restart++) {
      const app = await createInfoServer({ directory: join(directory, 'weather'), startUpdates: false, notams: { enabled: true, environment: 'production', directory,
        credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, now: () => at, fetch: async () => { requests++; throw Error('Source forbidden'); } });
      try {
        await app.notams.restore();
        assert.equal(app.notams.status.state, 'ready'); assert.equal(app.notams.status.unresolvedRecords, 0);
        assert.equal(app.notams.status.checkedAt, at); assert.equal(app.notams.status.watermark, at); assert.equal(app.notams.status.fullSyncAt, at);
        for (const issue of fixture.scopes) {
          const station = app.notams.readNavaid({ navaidId: issue.locations[0]! })!;
          assert.ok(station.records.some(r => r.id === issue.id)); assert.deepEqual(station.issues, []);
          for (const code of issue.icaoLocations) {
            const snapshot = code.startsWith('KZ') ? app.notams.readRegion({ firId: code })! : app.notams.readAirport({ icaoId: code })!;
            assert.ok(snapshot.records.some(r => r.id === issue.id)); assert.deepEqual(snapshot.issues, []);
          }
        }
      } finally { await app.close(); }
    }
    assert.equal(requests, 0); assert.deepEqual(await readFile(join(state, 'budget.json')), budget);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
