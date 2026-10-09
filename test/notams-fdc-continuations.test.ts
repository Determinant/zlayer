import assert from 'node:assert/strict';
import test from 'node:test';
import { isNotamRecord, isNotamSourceIssue, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import current from './fixtures/notams-representations-2026-10-09.json';
import transport from './fixtures/notams-fdc-continuations-2026-10-09.json';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { compareNotamContent } from '../tools/info-server/notams/revision';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { fdcContinuationEvidence, qualifiedFdcLocalText } from '../src/layers/notams/source-text';
import { parseFdcIcaoFields, parseIcaoNotice } from '../src/layers/notams/representation';
import { parseNotam } from '../src/layers/notams/parser';

const raw: unknown = current.issues.find(issue => issue.locations[0] === 'N81');
assert.ok(isNotamSourceIssue(raw));
const issue: NotamSourceIssue = raw;
const collapsed = issue.variants.find(record => record.translations.length === 1)!;
const complete = issue.variants.find(record => record.translations.length === 2)!;
const records = transport.records.map((value): NotamRecord => { assert.ok(isNotamRecord(value)); return value; });
const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
const changed = (record: NotamRecord, fields: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = { ...record, ...fields }; return recordWithRevision(facts);
};
const replace = (record: NotamRecord, from: string, to: string) => changed(record, {
  text: record.text.replaceAll(from, to), translations: record.translations.map(t => ({ ...t, text: t.text.replaceAll(from, to) })),
});
const repeated = 'ALL OTHER DATA REMAINS AS PUBLISHED. HAMMONTON MUNI, HAMMONTON, NJ. ';

test('cancelled N81 predecessor identifies the exact transport boundaries without authorizing a cross-ID merge', () => {
  const old = records.find(record => record.locations[0] === 'N81')!;
  assert.equal(old.lifecycle, 'cancelled'); assert.notEqual(old.id, collapsed.id);
  assert.equal(Date.parse(old.canceledAt), collapsed.startsAt);
  assert.match(old.text, /END PART 1 OF 3/); assert.match(old.text, /END PART 2 OF 3/);
  assert.equal(normalized(old.text.replace(/END PART \d+ OF \d+/g, '').replace(/\bODP\s+/g, '')), collapsed.text);
  assert.equal(fdcContinuationEvidence([old, complete]), undefined);
  assert.equal(collectNotamRecords({ records: [] }, [old, complete]).records.length, 2);
});

test('current N81 evidence resolves in either order, retains every raw rendering and constrains sparse replays', () => {
  const original = JSON.stringify(issue);
  for (const order of [[collapsed, complete], [complete, collapsed]]) {
    const result = collectNotamRecords({ records: [] }, order);
    assert.equal(result.issues?.length ?? 0, 0); assert.equal(result.records.length, 1);
    const record = result.records[0]!;
    assert.equal(record.text, complete.text);
    assert.equal(record.updatedAt, complete.updatedAt); assert.equal(record.endsAt, complete.endsAt);
    assert.equal(record.translations.length, 3);
    for (const translation of order.flatMap(r => r.translations)) assert.ok(record.translations.some(t => t.type === translation.type && t.text === translation.text));
    assert.equal(compareNotamContent(...order as [NotamRecord, NotamRecord]).text.proof, 'fdc-continuation');
    assert.equal(collectNotamRecords(result, [...order, changed(record, { translations: [] })]), result);
    assert.equal(rebaseNotamRecords(result, [collapsed], complete.updatedAt + 1).issues?.length ?? 0, 0);
    const bodyOnly = changed(record, { text: complete.text.replace(/^ODP /, '') });
    assert.equal(qualifiedFdcLocalText(bodyOnly), complete.translations[0]!.text);
    assert.equal(parseNotam(bodyOnly).subject, 'ODP');
    for (const updates of [[collapsed, replace(complete, '134 FT MSL', '135 FT MSL')],
      [replace(complete, '134 FT MSL', '135 FT MSL'), changed(record, { translations: [] })]]) {
      assert.equal(collectNotamRecords(result, updates).issues?.length, 1);
    }
  }
  assert.equal(JSON.stringify(issue), original);
});

test('field-only FDC conversion is complete evidence, never an invented ICAO notice identity', () => {
  const raw = complete.translations.find(t => t.type === 'OTHER:ICAO')!.text;
  assert.equal(parseIcaoNotice(raw).ok, false);
  const parsed = parseFdcIcaoFields(raw); assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.locations, ['N81']); assert.equal(parsed.value.end, '2810101505EST');
  const segment = parsed.value.segments[0]!;
  assert.equal(normalized(raw.slice(segment.start, segment.end)), parsed.value.body);
  for (const invalid of [raw.replace('C) 2810101505EST\n', ''), raw.replace('B)', 'C)'), raw + '\nQ) ANOTHER',
    raw.replace('A) N81', 'A) N81 PART 1 OF 2'), raw + '\nEND PART 1 OF 2']) {
    assert.equal(parseFdcIcaoFields(invalid).ok, false);
  }
});

test('missing witnesses, altered content and malformed continuation envelopes remain unresolved', () => {
  const withoutIcao = changed(complete, { translations: complete.translations.filter(t => t.type !== 'OTHER:ICAO') });
  const alteredIcao = (from: string, to: string) => changed(complete, { translations: complete.translations.map(t =>
    t.type === 'OTHER:ICAO' ? { ...t, text: t.text.replace(from, to) } : t) });
  const pairs: [NotamRecord, NotamRecord][] = [
    [collapsed, withoutIcao], [changed(collapsed, { translations: [] }), complete],
    [collapsed, changed(complete, { translations: complete.translations.filter(t => t.type !== 'LOCAL_FORMAT') })],
    ...['134 FT MSL', 'RIGHT OF CENTERLINE', 'RWY 21:', 'TREE, NAVAID'].map(word => [replace(collapsed, word, `${word} CHANGED`), complete] as [NotamRecord, NotamRecord]),
    [replace(collapsed, repeated, repeated.replace('NJ.', 'NY.')), complete],
    [replace(collapsed, repeated, repeated.replace('REMAINS', 'DOES NOT REMAIN')), complete],
    [replace(collapsed, repeated, `${repeated}${repeated}`), complete],
    [replace(collapsed, repeated, `${repeated}EXC EMERG ACFT `), complete],
    [replace(collapsed, repeated, `END PART 1 OF 3 ${repeated}`), complete],
    [replace(collapsed, 'ALL OTHER DATA REMAINS AS PUBLISHED.', ''), complete],
    [collapsed, alteredIcao('134 FT MSL', '135 FT MSL')],
    [collapsed, alteredIcao('A) N81', 'A) N82')],
    [collapsed, alteredIcao('QPDAO', '')],
    [collapsed, alteredIcao('QPDAO', 'UNKNOWN')],
    [collapsed, alteredIcao('2610091505', '2610091605')],
    [collapsed, alteredIcao('2810101505EST', '2810101505')],
    [collapsed, changed(complete, { schedule: 'DLY 0800-1700' })],
    [collapsed, changed(complete, { number: '8609' })],
    [collapsed, changed(complete, { translations: [...complete.translations, { type: 'LOCAL_FORMAT', text: complete.translations[0]!.text.replace('134 FT MSL', '135 FT MSL') }] })],
  ];
  for (const [a, b] of pairs) for (const order of [[a, b], [b, a]]) {
    const result = collectNotamRecords({ records: [] }, order);
    assert.equal(result.issues?.length, 1, JSON.stringify(order.map(r => r.translations)));
    assert.equal(result.records.length, 0);
  }
  const truncated = { ...issue, variantsTruncated: true };
  assert.equal(collectNotamRecords({ records: [], issues: [truncated] }, issue.variants).issues?.length, 1);
});

test('other ODP transport families require a complete current conversion as well as agreeing body words', () => {
  for (const record of records.filter(record => record.lifecycle === 'active')) {
    const location = record.locations[0]!, icao = record.translations.find(t => t.type === 'OTHER:ICAO')!;
    const body = icao.text.slice(icao.text.indexOf('\nE) ') + 4).replace(new RegExp(`^${location} `), '');
    const interval = record.translations[0]!.text.match(/\d{10}-\d{10}EST/)![0];
    const prefix = `!FDC ${record.year.slice(-1)}/${record.number.padStart(4, '0')} ${location} ODP `;
    const current = changed(record, { text: `ODP ${body} ${interval}`, translations: [{ type: 'LOCAL_FORMAT', text: `${prefix}${body} ${interval}` }, icao] });
    const collapsedBody = normalized(record.text.replace(/END PART \d+ OF \d+/g, '').replace(/\bODP\s+/g, ''));
    const collapsed = changed(record, { text: collapsedBody, translations: [{ type: 'LOCAL_FORMAT', text: `${prefix}${collapsedBody} ${interval}` }] });
    for (const order of [[collapsed, current], [current, collapsed]]) {
      const result = collectNotamRecords({ records: [] }, order);
      // N94/SRE supply complete current conversions. MEB's end is stale and
      // MEB/TIX have malformed Q fields; their matching words are insufficient.
      const qualified = location === 'N94' || location === 'SRE';
      assert.equal(result.issues?.length ?? 0, qualified ? 0 : 1, location);
      if (qualified) assert.equal(result.records[0]!.text, current.text);
    }
  }
});

test('continuation comparison bounds the number of wrappers and rejects adjacent empty continuations', () => {
  for (const count of [1, 31, 32]) {
    const expand = (text: string) => {
      let inserted = 0;
      return normalized(text).replace(/\bFT\b/g, token => ++inserted <= count ? `${token} ${repeated.trim()}` : token);
    };
    const variant = changed(complete, { text: expand(complete.text), translations: [{ type: 'LOCAL_FORMAT', text: expand(complete.translations[0]!.text) }] });
    assert.equal(collectNotamRecords({ records: [] }, [variant, complete]).issues?.length ?? 0, count <= 31 ? 0 : 1);
  }
});
