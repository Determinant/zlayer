import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createNotamXmlParser, recordWithRevision } from '../tools/info-server/notams/normalize';
import { notamTime } from '../src/layers/notams/validity';
import { NotamStore, NOTAM_DAY_MS, type NotamGeneration } from '../tools/info-server/notams/store';
import { createNotamService } from '../tools/info-server/notams/service';
import { mergeNotamRecords, NotamRevisionConflict } from '../tools/info-server/notams/revision';
import { collectNotamRecords } from '../tools/info-server/notams/collection';
import { NotamError } from '../tools/info-server/notams/error';
import { createNotamResponder } from '../tools/info-server/notams/routes';
import { createInfoServer } from '../tools/info-server/server';
import { aixm, bulkXml, notice, NOTAM_NOW } from './fixtures/notams';
import { isNotamRecord, isNotamAirportSnapshot, type NotamRecord } from '@zlayer/contracts';

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
async function fdcRenderingPairs(): Promise<{ previous: NotamRecord; next: NotamRecord }[]> {
  const { pairs } = JSON.parse(await readFile(new URL('./fixtures/notams-fdc-renderings.json', import.meta.url), 'utf8'));
  for (const pair of pairs) { assert.ok(isNotamRecord(pair.previous)); assert.ok(isNotamRecord(pair.next)); }
  return pairs;
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
    { effectiveEnd: '202610051300' },
    { translations: [{ ...next.translations[0]!, text: next.translations[0]!.text.replace('09L', '09R') }] },
    { translations: [{ type: 'OTHER:ICAO', text: '<div>different wording</div>' }] },
  ]) assert.throws(() => mergeNotamRecords([previous], [normalized(notice({ ...next, ...overrides }))]), NotamRevisionConflict);
  const many = (start: number) => normalized(notice({ translations: Array.from({ length: 5 }, (_, i) => ({ type: `OTHER:${i + start}`, text: 'Raw source' })) }));
  assert.throws(() => mergeNotamRecords([many(0)], [many(5)]), /invalid-record/);
});
test('paired domestic and international renderings preserve raw variants without treating issue time as revision time', () => {
  const local = { type: 'LOCAL_FORMAT', text: '!TST 10/042 TST RWY 09L CLSD 2610041159-2610051200' };
  const suffix = 'A) KTST B) 2610041159 C) 2610051200 E) RWY 09L CLSD';
  const icao = { type: 'OTHER:ICAO', text: `A0042/26 NOTAMN Q) KZZZ/QMRLC////000/999/3700N12100W005 ${suffix}` };
  const previous = normalized(notice({ text: 'RWY 09L CLSD', translations: [local, icao] }));
  const domestic = { type: icao.type, text: `10/042 NOTAMN\r\nQ) KZZZ/QMRLC/IV/NBO/A/000/999/3700N12100W005\r\n${suffix}` };
  const next = normalized(notice({ ...previous, issuedAt: previous.issuedAt! - 120_000, translations: [local, domestic] }));
  const merged = mergeNotamRecords([previous], [next]);
  assert.equal(merged[0]?.issuedAt, next.issuedAt);
  assert.equal(merged[0]?.updatedAt, previous.updatedAt);
  assert.deepEqual(merged[0]?.translations, [...previous.translations, next.translations[1]]);
  assert.equal(mergeNotamRecords(merged, [previous, next]), merged, 'repeated representations cannot grow the record');
  const reversed = mergeNotamRecords([next], [previous]);
  assert.equal(reversed[0]?.issuedAt, next.issuedAt);
  assert.deepEqual(reversed[0]?.translations, [...next.translations, previous.translations[1]]);
  for (const [from, to] of [['IV/NBO/A', 'I/NBO/A'], ['KZZZ', 'KYYY'], ['QMRLC', 'QMRXX'],
    ['000/999', '000/100'], ['3700N12100W005', '3800N12100W005'], ['2610051200', '2610051300'],
    ['09L', '09R'], ['NOTAMN', 'NOTAMR A0041/26'], ['10/042', '10/043']]) {
    const conflicting = normalized(notice({ ...next, translations: [local, { ...domestic, text: domestic.text.replace(from!, to!) }] }));
    assert.throws(() => mergeNotamRecords(merged, [conflicting]), NotamRevisionConflict,
      'retained populated qualifiers must remain constraints even when another rendering omitted them');
  }
  for (const header of ['A0043/26', 'B0042/26', 'A0042/27']) {
    const conflicting = normalized(notice({ ...previous,
      translations: [local, { ...icao, text: icao.text.replace('A0042/26', header) }] }));
    assert.throws(() => mergeNotamRecords([previous], [conflicting]), NotamRevisionConflict);
    assert.throws(() => mergeNotamRecords([conflicting], [previous]), NotamRevisionConflict);
  }
});
test('full ICAO bodies reconcile only with an identical retained translation and preserve optional references', () => {
  const text = 'RWY 09L CLSD\nEXC EMERG ACFT';
  const icao = `A0043/26 NOTAMR A0042/26 Q) KZZZ/QMRLC////000/999/3700N12100W005 A) KTST B) 2610041159 E) ${text}`;
  const previous = normalized(notice({ number: '0043', series: 'A', text, changeType: 'R',
    referred: { series: 'A', number: '0042', year: '2026' }, translations: [{ type: 'OTHER:ICAO', text: icao }] }));
  const next = normalized(notice({ ...previous, number: '43', referred: null, text: icao,
    translations: [{ type: 'OTHER:ICAO', text: `<pre>\n${icao}\n</pre>` }] }));
  const saved = [previous];
  assert.equal(mergeNotamRecords(saved, [next]), saved);
  const reversed = mergeNotamRecords([next], saved);
  assert.equal(reversed[0]?.text, text); assert.deepEqual(reversed[0]?.referred, previous.referred);
  assert.equal(reversed[0]?.lifecycle, 'active');
  assert.equal(mergeNotamRecords(reversed, [previous, next]), reversed);
  for (const overrides of [
    { referred: { series: 'A', number: '0041', year: '2026' } },
    { translations: [] }, { text: icao.replace('09L', '09R') }, { changeType: 'N' },
    { translations: [{ type: 'OTHER:ICAO', text: icao.replace('A0042/26', 'A0041/26') }] },
  ]) assert.throws(() => mergeNotamRecords(saved, [normalized(notice({ ...next, ...overrides }))]), NotamRevisionConflict);
});
test('captured FDC bodies and estimated-end spellings reconcile through their shared local rendering', async () => {
  for (const pair of await fdcRenderingPairs()) {
    for (const [previous, next] of [[pair.previous, pair.next], [pair.next, pair.previous]] as const) {
      const merged = mergeNotamRecords([previous], [next]), record = merged[0]!;
      assert.equal(record.text, previous.text, 'retain the first raw body spelling');
      assert.equal(record.effectiveEnd, previous.effectiveEnd);
      assert.equal(record.endKind, 'estimated');
      assert.equal(record.startsAt, previous.startsAt); assert.equal(record.endsAt, previous.endsAt);
      assert.equal(record.updatedAt, previous.updatedAt); assert.equal(record.sourceUpdatedAt, previous.sourceUpdatedAt);
      assert.equal(record.translations.length, 2, 'retain the optional ICAO rendering without using its old dates as equivalence evidence');
      assert.equal(mergeNotamRecords(merged, [previous, next]), merged);
    }
    for (const subject of ['SID', 'IAP', 'STAR', 'ODP']) {
      const previous = recordWithRevision({ ...pair.previous,
        translations: pair.previous.translations.map(t => ({ ...t, text: t.text.replace(' SID ', ` ${subject} `) })) });
      const interval = '2610061800-2610062200EST';
      for (const text of [previous.text, `${subject} ${previous.text}`, `${previous.text} ${interval}`, `${subject} ${previous.text} ${interval}`]) {
        const next = recordWithRevision({ ...previous, text, effectiveEnd: pair.next.effectiveEnd });
        assert.equal(mergeNotamRecords([previous], [next])[0], previous);
      }
    }
  }
});
test('FDC rendering equivalence requires matching identity, complete local text and valid time qualifiers', async () => {
  const { previous, next } = (await fdcRenderingPairs())[0]!;
  const replaceLocal = (from: string, to: string) => next.translations.map(t => t.type === 'LOCAL_FORMAT'
    ? { ...t, text: t.text.replace(from, to) } : t);
  for (const changes of [
    { text: next.text.replace('NA EXCEPT', 'NA') },
    { text: next.text.replace('GPS', 'DME/DME') },
    { text: next.text.replace('SID', 'IAP') },
    { text: next.text.replace('2200EST', '2300EST') },
    { translations: [] },
    { translations: replaceLocal('GPS', 'DME/DME') },
    { effectiveEnd: '202610062300', endsAt: next.endsAt! + 3600_000 },
    { effectiveEnd: 'PERM', endsAt: null, endKind: 'permanent' as const },
    { lifecycle: 'cancelled' as const },
  ]) assert.throws(() => mergeNotamRecords([previous], [recordWithRevision({ ...next, ...changes })]), NotamRevisionConflict);
  for (const [from, to] of [['6/7442', '6/7449'], ['6/7442', '5/7442'], ['FCM SID', 'ANE SID'],
    ['2610061800', '2610061700'], ['2610062200EST', '2610062300EST']]) {
    const translations = replaceLocal(from!, to!);
    assert.throws(() => mergeNotamRecords([recordWithRevision({ ...previous, translations })],
      [recordWithRevision({ ...next, translations })]), NotamRevisionConflict,
    'a shared translation for a different identity or interval cannot establish body equivalence');
  }
  const fixed = recordWithRevision({ ...previous, effectiveEnd: next.effectiveEnd, endKind: 'fixed',
    translations: previous.translations.map(t => ({ ...t, text: t.text.replace('2200EST', '2200') })) });
  assert.equal(fixed.endKind, 'fixed');
  assert.throws(() => mergeNotamRecords([previous], [fixed]), NotamRevisionConflict);
  const unknown = { ...next, endKind: 'unknown' as const, revision: 'f'.repeat(64) };
  assert.throws(() => mergeNotamRecords([{ ...previous, endKind: 'unknown' }], [unknown]), NotamRevisionConflict);
});
test('duplicate inactive records do not depend on presentation or cancel other source IDs', () => {
  for (const lifecycle of ['cancelled', 'cancellation'] as const) {
    const previous = normalized(notice({ lifecycle, changeType: lifecycle === 'cancellation' ? 'C' : 'N' }));
    const next = normalized(notice({ ...previous, text: 'M0042/26 NOTAMC M0041/26\nA) KTST',
      translations: [{ type: 'LOCAL_FORMAT', text: 'M0042/26 NOTAMC M0041/26' }],
      referred: { series: 'M', number: '0041', year: '2026' } }));
    const saved = [previous];
    assert.equal(mergeNotamRecords(saved, [next]), saved, 'retain the raw inactive record already held');
    assert.equal(mergeNotamRecords([next], saved)[0], next, 'either representation proves the same inactive state');
    const active = normalized(notice({ id: '1757600000000002', sourceId: '1757600000000002' }));
    assert.ok(mergeNotamRecords([previous, active], [next]).includes(active), 'references never delete another source ID');
    if (lifecycle === 'cancelled') {
      assert.equal(mergeNotamRecords(saved, [normalized(notice())])[0], previous,
        'omitting the cancellation field cannot resurrect its timestamped original-ID tombstone');
      assert.equal(mergeNotamRecords([normalized(notice())], [next])[0], next,
        'the matching cancellation timestamp establishes the inactive source state');
    } else {
      assert.throws(() => mergeNotamRecords(saved, [normalized(notice())]), NotamRevisionConflict);
      assert.throws(() => mergeNotamRecords([normalized(notice())], [next]), NotamRevisionConflict,
        'a NOTAMC message is not the original-ID tombstone');
    }
  }
});
test('unresolved records and independent updates commit atomically and survive checksummed restoration', async () => {
  const previous = Array.from({ length: 40 }, (_, i) => normalized(notice({ id: String(i).padStart(16, '0'), sourceId: String(i).padStart(16, '0') })));
  const original = structuredClone(previous);
  const collection = collectNotamRecords({ records: previous }, previous.map(r => normalized(notice({ ...r, text: 'Changed restriction' }))));
  assert.equal(collection.records.length, 0); assert.equal(collection.issues?.length, 40);
  assert.deepEqual(previous, original);
  const directory = await mkdtemp(join(tmpdir(), 'notam-source-issues-'));
  let store = new NotamStore(directory, 'staging', () => NOTAM_NOW);
  try {
    await store.restore(); const published = await store.publish({ ...generation(collection.records), issues: collection.issues! });
    assert.equal(JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')).issueCount, 40);
    await store.close(); store = new NotamStore(directory, 'staging', () => NOTAM_NOW);
    const restored = await store.restore(); assert.equal(restored?.generation, published.generation);
    assert.deepEqual(restored?.issues, collection.issues); assert.equal(restored?.complete, true);
    const path = join(directory, `${published.generation}.ndjson`);
    await store.close(); await writeFile(path, (await readFile(path, 'utf8')).replace('Changed restriction', 'Changed Restriction'));
    store = new NotamStore(directory, 'staging', () => NOTAM_NOW);
    assert.equal(await store.restore(), undefined); assert.equal(store.recoveryError, 'invalid-checkpoint');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
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
test('bounded multi-version evidence survives JSON expansion and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-escaped-evidence-'));
  let store = new NotamStore(directory, 'staging', () => NOTAM_NOW);
  const { revision: _revision, ...facts } = normalized(notice());
  const translations = Array.from({ length: 7 }, (_, i) => ({ type: `OTHER:${i}`, text: '"\n'.repeat(125_000) }));
  const variants = Array.from({ length: 8 }, (_, i) => recordWithRevision({ ...facts, text: `Source version ${i}`, translations }));
  assert.ok(variants.every(isNotamRecord));
  const collection = collectNotamRecords({ records: [] }, variants);
  try {
    await store.restore(); const saved = await store.publish({ ...generation([]), ...collection });
    assert.ok((await stat(join(directory, `${saved.generation}.ndjson`))).size > 24 * 1024 * 1024);
    await store.close(); store = new NotamStore(directory, 'staging', () => NOTAM_NOW);
    const restored = await store.restore();
    assert.equal(restored?.generation, saved.generation); assert.equal(store.recoveryError, undefined);
    assert.deepEqual(restored?.issues, collection.issues);
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
    { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async input => {
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
    const responses = createNotamResponder(service);
    for (let i = 0; i < 100; i++) assert.equal(responses.read('/api/notams/airports?faaId=tst&icaoId=KTST', undefined).status, 200);
    assert.equal(calls.length, 4, 'airport reads never spend quota');
    assert.equal(service.readAirport({ faaId: 'TST', icaoId: 'KTST' })?.records.length, 1, 'alias union deduplicates');
    assert.equal(service.readAirport({ faaId: 'ZZZ' })?.records.length, 0, 'accountability is not airport location');
    assert.equal(service.readAirport({ icaoId: 'KTST' })?.associationCoverage, 'incomplete');
    for (const query of ['id=KTST', 'faaId=TST&faaId=TST', 'faaId=', 'faaId=TST&url=x']) {
      assert.equal(responses.read(`/api/notams/airports?${query}`, undefined).status, 400);
    }
    time += 180_000; invalid = true; service.refresh(); await service.settled();
    assert.equal(service.status.state, 'degraded'); assert.equal(service.status.generation, generation);
    time += 180_001; invalid = false; updates = [notice({ updatedAt: time - 1, lifecycle: 'cancelled' })];
    service.refresh(); await service.settled(); assert.equal(service.readAirport({ faaId: 'TST' })?.records.length, 0);
    const journal = JSON.parse(await readFile(join(directory, 'staging', 'budget.json'), 'utf8'));
    assert.ok(journal.bulkAt >= NOTAM_NOW + NOTAM_DAY_MS);
  } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
for (const failure of ['bulk-invalid', 'bridge-transport'] as const) {
  test(`failed replacement ${failure} preserves live continuity and resumes budgeted deltas`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notam-replacement-')), controller = new AbortController();
    let time = NOTAM_NOW - NOTAM_DAY_MS, fail = true, deltas = 0;
    const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
    await seed.restore(); await seed.reserve('bulk'); time = NOTAM_NOW;
    const original = await seed.publish(generation([normalized(notice())], time - 180_000)); await seed.close();
    const service = createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
      { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async input => {
        const url = new URL(String(input)); time += 1001;
        if (url.pathname === '/v1/auth/token') return Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' });
        if (url.pathname.endsWith('/il')) return Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } });
        if (url.pathname.endsWith('/content/fixture')) return new Response(gzipSync(bulkXml([
          notice(),
        ], time, failure === 'bulk-invalid' ? 2 : 1)));
        deltas++;
        if (fail && failure === 'bridge-transport') return new Response('', { status: 503 });
        return Response.json({ status: 'Success', data: { aixm: [] } });
      } });
    try {
      await service.restore(); service.refresh(); await service.settled();
      if (failure !== 'bulk-invalid') {
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
test('an unfamiliar conflict stays explicit while other airports advance across restart and later resolution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-live-issue-')), controller = new AbortController();
  let time = NOTAM_NOW, conflict = true;
  const requests: string[] = [], logs: string[] = [];
  const other = notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002', locations: ['AUX'], icaoLocations: ['KAUX'] });
  const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
  await seed.restore(); await seed.reserve('bulk'); await seed.publish(generation([normalized(notice()), normalized(other)])); await seed.close();
  time += 180_000;
  const create = () => createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, log: value => logs.push(value), fetch: async input => {
      requests.push(String(input)); time += 1001;
      return new URL(String(input)).pathname === '/v1/auth/token'
        ? Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' })
        : Response.json({ status: 'Success', data: { aixm: [aixm(notice(conflict ? { text: 'Unfamiliar conflicting representation' }
          : { updatedAt: time - 1000, text: 'Resolved source revision' })), aixm(notice({ ...other, updatedAt: time - 1000, text: `Independent update ${time}` }))] } });
    } });
  let service = create();
  try {
    await service.restore(); service.refresh(); await service.settled();
    assert.equal(service.status.error, 'unresolved-records'); assert.equal(service.status.continuity, 'incomplete');
    assert.equal(service.status.collectionContinuity, 'complete'); assert.equal(service.status.unresolvedRecords, 1);
    const affected = service.readAirport({ faaId: 'TST' })!, unaffected = service.readAirport({ faaId: 'AUX' })!;
    assert.ok(isNotamAirportSnapshot(affected)); assert.ok(isNotamAirportSnapshot(unaffected));
    assert.equal(affected.contentCoverage, 'incomplete'); assert.equal(affected.records.length, 0);
    assert.equal(affected.issues?.[0]?.variants.length, 2);
    assert.equal(unaffected.contentCoverage, 'complete'); assert.equal(unaffected.issues?.length, 0);
    assert.match(unaffected.records[0]!.text, /Independent update/);
    const manifest = JSON.parse(await readFile(join(directory, 'staging', 'current.json'), 'utf8'));
    assert.equal(manifest.complete, true); assert.equal(manifest.schemaVersion, 2); assert.equal(manifest.issueCount, 1);
    assert.ok(manifest.watermark > NOTAM_NOW);
    assert.ok(logs.every(log => !log.includes('Unfamiliar conflicting representation')));
    const budget = await readFile(join(directory, 'staging', 'budget.json'), 'utf8');
    await service.close(); service = create(); await service.restore();
    assert.equal(service.status.error, 'unresolved-records');
    assert.deepEqual(service.readAirport({ faaId: 'TST' })?.issues, affected.issues);
    assert.equal(await readFile(join(directory, 'staging', 'budget.json'), 'utf8'), budget);
    const before = requests.length; service.refresh(); await service.settled(); assert.equal(requests.length, before);
    time += 180_000; service.refresh(); await service.settled();
    assert.ok(service.status.watermark! > manifest.watermark);
    assert.equal(service.status.unresolvedRecords, 1);
    assert.notEqual(service.readAirport({ faaId: 'AUX' })?.records[0]?.text, unaffected.records[0]!.text);
    assert.equal(Date.parse(new URL(requests.at(-1)!).searchParams.get('lastUpdatedDate')!), Math.floor((manifest.watermark - 600_000) / 1000) * 1000);
    conflict = false; time += 180_000; service.refresh(); await service.settled();
    assert.equal(service.status.state, 'ready'); assert.equal(service.status.continuity, 'complete'); assert.equal(service.status.unresolvedRecords, 0);
    assert.equal(service.readAirport({ faaId: 'TST' })?.records[0]?.text, 'Resolved source revision');
    assert.equal(JSON.parse(await readFile(join(directory, 'staging', 'budget.json'), 'utf8')).bulkAt, JSON.parse(budget).bulkAt);
    assert.ok(requests.every(url => !url.includes('/il')));
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
  const { sha256: _sha256, issueCount: _issueCount, ...legacyManifest } = manifest;
  await writeFile(path, JSON.stringify({ ...legacyManifest, schemaVersion: 1, complete: false }));
  const budget = JSON.parse(await readFile(join(directory, 'staging', 'budget.json'), 'utf8'));
  time += 180_000;
  const calls: URL[] = [];
  const service = createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async input => {
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

test('failed publication cannot advance collection time or expose partial issue updates', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-publication-failure-')), controller = new AbortController();
  let time = NOTAM_NOW, blocked = true;
  const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
  await seed.restore(); await seed.reserve('bulk'); const original = await seed.publish(generation([normalized(notice())])); await seed.close();
  const publish = NotamStore.prototype.publish;
  t.mock.method(NotamStore.prototype, 'publish', async function(this: NotamStore, ...args: Parameters<typeof publish>) {
    if (blocked) throw new NotamError('storage-unavailable');
    return publish.apply(this, args);
  });
  const create = () => createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async input => {
      time += 1001;
      return new URL(String(input)).pathname === '/v1/auth/token'
        ? Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' })
        : Response.json({ status: 'Success', data: { aixm: [aixm(notice({ text: 'Unfamiliar source version' }))] } });
    } });
  let service = create();
  try {
    time += 180_000; await service.restore(); service.refresh(); await service.settled();
    assert.equal(service.status.error, 'storage-unavailable'); assert.equal(service.status.watermark, original.watermark);
    assert.equal(service.status.unresolvedRecords, 0); assert.equal(service.status.generation, original.generation);
    await service.close(); service = create(); await service.restore();
    assert.equal(service.status.watermark, original.watermark);
    blocked = false; time += 180_000; service.refresh(); await service.settled();
    assert.ok(service.status.watermark! > original.watermark); assert.equal(service.status.unresolvedRecords, 1);
    assert.equal(service.readAirport({ faaId: 'TST' })?.records.length, 0);
    assert.equal(service.readAirport({ faaId: 'TST' })?.issues?.length, 1);
  } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('version-1 snapshots migrate without erasing quota and unscoped issues qualify every airport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-legacy-schema-')), controller = new AbortController();
  let time = NOTAM_NOW;
  const stateDirectory = join(directory, 'staging'), seed = new NotamStore(stateDirectory, 'staging', () => time);
  await seed.restore(); await seed.reserve('bulk'); await seed.publish(generation([normalized(notice())])); await seed.close();
  const manifest = JSON.parse(await readFile(join(stateDirectory, 'current.json'), 'utf8'));
  manifest.schemaVersion = 1; delete manifest.issueCount; delete manifest.sha256;
  await writeFile(join(stateDirectory, 'current.json'), JSON.stringify(manifest));
  const budget = JSON.parse(await readFile(join(stateDirectory, 'budget.json'), 'utf8'));
  const service = createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async input => {
      time += 1001;
      return new URL(String(input)).pathname === '/v1/auth/token'
        ? Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' })
        : Response.json({ status: 'Success', data: { aixm: [aixm(notice({ locations: [], icaoLocations: [], changeType: 'UNSUPPORTED' }))] } });
    } });
  try {
    await service.restore(); assert.equal(service.status.watermark, manifest.watermark);
    time += 180_000; service.refresh(); await service.settled();
    assert.equal(service.status.collectionContinuity, 'complete'); assert.equal(service.status.unscopedRecords, 1);
    for (const query of [{ faaId: 'TST', icaoId: 'KTST' }, { faaId: 'AUX' }, { icaoId: 'PANC' }]) {
      const snapshot = service.readAirport(query)!; assert.ok(isNotamAirportSnapshot(snapshot));
      assert.equal(snapshot.issues?.length, 1); assert.equal(snapshot.contentCoverage, 'incomplete');
    }
    assert.equal(JSON.parse(await readFile(join(stateDirectory, 'current.json'), 'utf8')).schemaVersion, 2);
    assert.equal(JSON.parse(await readFile(join(stateDirectory, 'budget.json'), 'utf8')).bulkAt, budget.bulkAt);
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
    { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async input => {
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

test('captured FDC conflicts recover every airport, survive restart and advance subsequent deltas without new bulk quota', async () => {
  const pairs = await fdcRenderingPairs(), previous = pairs.map(pair => pair.previous);
  const directory = await mkdtemp(join(tmpdir(), 'notam-fdc-replay-')), controller = new AbortController();
  const baseline = previous[0]!.updatedAt + 60_000;
  let time = baseline;
  const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
  await seed.restore(); await seed.reserve('bulk'); await seed.publish(generation(previous, baseline));
  await seed.invalidate('revision-conflict'); await seed.close();
  const budgetPath = join(directory, 'staging', 'budget.json'), budget = JSON.parse(await readFile(budgetPath, 'utf8'));
  time += 90 * 60_000;
  const calls: URL[] = [];
  const create = () => createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async input => {
      const url = new URL(String(input)); calls.push(url); time += 1001;
      return url.pathname === '/v1/auth/token'
        ? Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' })
        : Response.json({ status: 'Success', data: { aixm: pairs.flatMap(pair => [aixm(pair.previous), aixm(pair.next)]) } });
    } });
  let service = create();
  try {
    await service.restore(); assert.equal(service.status.continuity, 'incomplete');
    service.refresh(); await service.settled();
    assert.equal(service.status.state, 'ready'); assert.equal(service.status.continuity, 'complete');
    assert.equal(Date.parse(calls[1]!.searchParams.get('lastUpdatedDate')!), baseline - 600_000);
    for (const { previous } of pairs) {
      const record = service.readAirport({ faaId: previous.locations[0]! })?.records[0];
      assert.equal(record?.id, previous.id); assert.equal(record?.text, previous.text);
      assert.equal(record?.translations.length, 2); assert.equal(record?.endKind, 'estimated');
    }
    let checkedAt = service.status.checkedAt!;
    await service.close(); service = create(); await service.restore();
    const attempts = calls.length; service.refresh(); await service.settled(); assert.equal(calls.length, attempts);
    for (let round = 0; round < 3; round++) {
      time += 180_000; service.refresh(); await service.settled();
      assert.equal(service.status.state, 'ready'); assert.equal(service.status.error, null);
      assert.ok(service.status.checkedAt! > checkedAt); checkedAt = service.status.checkedAt!;
      assert.equal(service.status.recordCount, 3);
    }
    assert.equal(JSON.parse(await readFile(budgetPath, 'utf8')).bulkAt, budget.bulkAt);
    assert.ok(calls.every(url => !url.pathname.endsWith('/il')));
  } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('inactive rendering conflicts recover the complete feed and stay excluded across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-inactive-recovery-')), controller = new AbortController();
  let time = NOTAM_NOW;
  const cancelledMessage = normalized(notice({ changeType: 'C', text: 'ARFF CAPABILITY DOWNGRADED\nCANCELED' }));
  const active = normalized(notice({ id: '1757600000000002', sourceId: '1757600000000002' }));
  const added = normalized(notice({ id: '1757600000000003', sourceId: '1757600000000003', text: 'RWY 09L CLSD' }));
  const sparse = notice({ ...cancelledMessage, text: 'M0042/26 NOTAMC M0041/26\nA) KTST',
    translations: [{ type: 'LOCAL_FORMAT', text: 'M0042/26 NOTAMC M0041/26' }] });
  const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
  await seed.restore(); await seed.reserve('bulk'); await seed.publish(generation([cancelledMessage, active]));
  await seed.invalidate('revision-conflict'); await seed.close();
  const budgetPath = join(directory, 'staging', 'budget.json'), budget = JSON.parse(await readFile(budgetPath, 'utf8'));
  time += 6 * 3600_000;
  const calls: URL[] = [];
  const create = () => createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async input => {
      const url = new URL(String(input)); calls.push(url); time += 1001;
      return url.pathname === '/v1/auth/token'
        ? Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' })
        : Response.json({ status: 'Success', data: { aixm: [aixm(sparse), aixm(added)] } });
    } });
  let service = create();
  try {
    await service.restore(); service.refresh(); await service.settled();
    assert.equal(service.status.state, 'ready'); assert.equal(service.status.continuity, 'complete');
    assert.equal(service.status.error, null); assert.equal(service.status.recordCount, 3);
    assert.deepEqual(service.readAirport({ faaId: 'TST' })?.records.map(r => r.id).sort(), [active.id, added.id]);
    const recovered = service.status.checkedAt!;
    assert.equal(Date.parse(calls[1]!.searchParams.get('lastUpdatedDate')!), NOTAM_NOW - 600_000);
    await service.close(); service = create(); await service.restore();
    const attempts = calls.length; service.refresh(); await service.settled(); assert.equal(calls.length, attempts);
    time += 180_000; service.refresh(); await service.settled();
    assert.equal(service.status.state, 'ready'); assert.ok(service.status.checkedAt! > recovered);
    assert.equal(service.readAirport({ faaId: 'TST' })?.records.length, 2);
    assert.equal(JSON.parse(await readFile(budgetPath, 'utf8')).bulkAt, budget.bulkAt);
    assert.ok(calls.every(url => !url.pathname.endsWith('/il')));
  } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const bulkFails of [false, true]) {
  test(`daily reconciliation runs with unresolved data; bulk failure=${bulkFails} preserves ongoing collection`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notam-due-bulk-')), controller = new AbortController();
    let time = NOTAM_NOW - 23 * 3600_000, conflicting = true;
    const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
    await seed.restore(); await seed.reserve('bulk'); const due = seed.nextBulkAt;
    time = NOTAM_NOW;
    const original = normalized(notice());
    await seed.publish(generation([original])); await seed.invalidate('revision-conflict'); await seed.close();
    const calls: URL[] = [];
    const service = createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
      { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async input => {
        const url = new URL(String(input)); calls.push(url); time += 1001;
        if (url.pathname === '/v1/auth/token') return Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' });
        if (url.pathname.endsWith('/il')) return bulkFails ? new Response('', { status: 500 })
          : Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } });
        if (url.pathname.endsWith('/content/fixture')) return new Response(gzipSync(bulkXml([notice({ updatedAt: time - 1000, text: 'Fresh baseline' })], time)));
        return Response.json({ status: 'Success', data: { aixm: conflicting ? [aixm(notice({ text: 'Conflicting old rendering' }))] : bulkFails ? [aixm(notice({ updatedAt: time - 1000, text: 'Resolved source' }))] : [] } });
      } });
    try {
      await service.restore(); service.refresh(); await service.settled(); assert.equal(service.status.error, 'unresolved-records');
      const collectedAt = service.status.watermark!;
      const before = calls.length;
      time = due + 1000; service.refresh(); await service.settled();
      assert.ok(calls.slice(before).some(url => url.pathname.endsWith('/il')), 'full rebase must run while the replay prefix is still within 24 hours');
      assert.ok(!calls.slice(before).some(url => url.searchParams.has('lastUpdatedDate')));
      assert.equal(service.status.continuity, 'incomplete', 'bulk alone cannot claim a bridged generation');
      const bridgeFrom = bulkFails ? collectedAt : JSON.parse(await readFile(join(directory, 'staging', 'candidate.json'), 'utf8')).watermark;
      conflicting = false; time += 180_000; service.refresh(); await service.settled();
      assert.equal(service.status.state, 'ready'); assert.equal(service.status.error, null);
      assert.equal(service.readAirport({ faaId: 'TST' })?.records[0]?.text, bulkFails ? 'Resolved source' : 'Fresh baseline');
      const delta = calls.at(-1)!;
      assert.equal(Date.parse(delta.searchParams.get('lastUpdatedDate')!), Math.floor((bridgeFrom - 600_000) / 1000) * 1000);
      assert.equal(calls.filter(url => url.pathname.endsWith('/il')).length, 1, 'a failed bulk still consumes the daily allowance');
    } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

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
    { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async () => { requests++; throw new Error('Unexpected source request'); } });
  try {
    await service.restore(); service.refresh(); await service.settled();
    assert.equal(requests, 0); assert.equal(service.status.error, 'revision-conflict');
    assert.equal(service.status.nextAttemptAt, NOTAM_NOW + NOTAM_DAY_MS);
    time += 180_000; service.refresh(); await service.settled();
    assert.equal(requests, 0); assert.equal(service.status.error, 'revision-conflict');
  } finally { controller.abort(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
test('26 hours of collection preserve a persistent conflict through restarts, transient failures and daily reconciliation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-soak-')), controller = new AbortController();
  let time = NOTAM_NOW, pulls = 0, bulkPulls = 0;
  const independent = notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002', locations: ['AUX'], icaoLocations: ['KAUX'] });
  const seed = new NotamStore(join(directory, 'staging'), 'staging', () => time);
  await seed.restore(); await seed.reserve('bulk'); await seed.publish(generation([normalized(notice()), normalized(independent)])); await seed.close();
  const dataTimes: number[] = [];
  const create = () => createNotamService({ enabled: true, environment: 'staging', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    { now: () => time, wait: async ms => { time += ms; }, signal: controller.signal, fetch: async input => {
      const url = new URL(String(input)); time += 1001;
      if (url.pathname === '/v1/auth/token') return Response.json({ access_token: 'fixture', expires_in: '1799', token_type: 'BearerToken' });
      if (url.pathname.endsWith('/content/fixture')) return new Response(gzipSync(bulkXml([notice(), notice({ ...independent, updatedAt: time - 1000 })], time)));
      dataTimes.push(time);
      if (url.pathname.endsWith('/il')) { bulkPulls++; return Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } }); }
      pulls++;
      if (pulls === 150) return new Response('', { status: 503 });
      if (pulls === 250) return new Response('{"status":"Success","data":', { status: 200 });
      return Response.json({ status: 'Success', data: { aixm: [aixm(notice({ text: 'An unresolved source restriction' })),
        aixm(notice({ ...independent, updatedAt: time - 1000, text: `Independent observation ${pulls}` }))] } });
    } });
  let service = create();
  try {
    await service.restore();
    for (let round = 0; round < 520; round++) {
      time += 180_001;
      const before = service.status.watermark!;
      service.refresh(); await service.settled();
      assert.ok(service.status.watermark! >= before);
      assert.equal(service.status.collectionContinuity, 'complete');
      assert.equal(service.readAirport({ faaId: 'TST' })?.issues?.length, 1);
      assert.equal(service.readAirport({ faaId: 'AUX' })?.contentCoverage, 'complete');
      if (round === 160 || round === 360) {
        const checkpoint = service.status;
        await service.close(); service = create(); await service.restore();
        assert.equal(service.status.watermark, checkpoint.watermark); assert.equal(service.status.unresolvedRecords, 1);
        const count = dataTimes.length; service.refresh(); await service.settled(); assert.equal(dataTimes.length, count);
      }
    }
    assert.equal(bulkPulls, 1); assert.ok(pulls >= 510);
    assert.ok(dataTimes.every((at, i) => !i || at - dataTimes[i - 1]! >= 180_000));
    assert.ok(service.status.checkedAt! > NOTAM_NOW + 26 * 3600_000);
    assert.ok(service.status.fullSyncAt! >= NOTAM_NOW + NOTAM_DAY_MS);
    assert.equal(service.status.error, 'unresolved-records');
    assert.match(service.readAirport({ faaId: 'AUX' })?.records[0]?.text ?? '', new RegExp(`observation ${pulls}$`));
    const files = await readdir(join(directory, 'staging'));
    assert.ok(files.filter(name => name.endsWith('.ndjson')).length <= 3);
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
