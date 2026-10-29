import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotamRecord } from '@zlayer/contracts';
import { changeGeneratedNotam as changed, generatedNotams } from './fixtures/notams-generated';
import { compareNotamScopes } from '../tools/info-server/notams/association-scopes';
import { evaluateNotamContent } from '../tools/info-server/notams/content';
import { resolveNotamRevision } from '../tools/info-server/notams/revision';
import { classifyNotamIssue, describeNotamIssue } from '../tools/info-server/notams/source-issues';
import { collectNotamRecords } from '../tools/info-server/notams/collection';

const sample = [...generatedNotams()].find(value => value.keyword === 'NAV' && value.end === 'fixed' && !value.schedule)!;
const b = changed(sample.full, { translations: sample.full.translations.filter(t => t.type === 'OTHER:ICAO') });
const a = changed(b, { icaoLocations: [sample.station] });
const translation = (record: NotamRecord, from: string, to: string) => changed(record, {
  translations: record.translations.map(t => ({ ...t, text: t.text.replace(from, to) })),
});

test('association failures identify the first failed evidence check without granting a merge', () => {
  const cases: [string, NotamRecord, NotamRecord][] = [
    ['lifecycle-unproven', changed(a, { lifecycle: 'unknown' }), b],
    ['filing-location-mismatch', changed(a, { locations: ['TST'] }), b],
    ['projected-associations', changed(a, { icaoLocationVariants: [[sample.station], [sample.fir]] }), b],
    ['non-singleton-scope', changed(a, { icaoLocations: [sample.station, 'CZZZ'] }), b],
    ['scope-count-limit', changed(a, { icaoLocations: [sample.station, 'CZZZ'], sourceIcaoLocations: [[sample.station], ['CZZZ']] }), b],
    ['scope-roles-unproven', changed(a, { icaoLocations: ['PAAA'] }), changed(b, { icaoLocations: ['PBBB'] })],
    ['missing-icao-witness', changed(a, { translations: [] }), b],
    ['icao-rendering-or-body-unproven', a, changed(b, { text: b.text + ' EXC EMERGENCY' })],
    ['icao-rendering-or-body-unproven', a, translation(b, ' B)', ' UNKNOWN)')],
    ['fir-mismatch', a, translation(b, `Q) ${sample.fir}`, 'Q) CZZZ')],
    ['fir-mismatch', a, translation(b, `A) ${sample.fir}`, 'A) CZZZ')],
    ['icao-identity-or-interval-mismatch', a, translation(b, '2610041159', '2610041200')],
    ['icao-identity-or-interval-mismatch', a, translation(b, '/26 NOTAMN', '/25 NOTAMN')],
    ['schedule-mismatch', a, changed(b, { schedule: 'DLY 1200-1400' })],
    ['icao-content-mismatch', a, translation(b, '3500N12000W005', '3500N12000W010')],
    ['station-prefix-missing', changed(a, { locations: ['TST'], icaoLocations: ['TST'] }), changed(b, { locations: ['TST'] })],
    ['translation-type-unsupported', a, changed(b, { translations: [...b.translations, { type: 'OTHER:UNKNOWN', text: 'UNKNOWN' }] })],
    ['local-syntax-unsupported', a, changed(b, { translations: [...b.translations, { type: 'LOCAL_FORMAT', text: 'INCOMPLETE' }] })],
    ['local-identity-or-interval-mismatch', a, changed(b, { translations: [...b.translations, { type: 'LOCAL_FORMAT',
      text: `!TST 10/001 TST NAV TEST 2610041159-2610051200` }] })],
    ['local-body-mismatch', a, changed(b, { translations: [...b.translations, { type: 'LOCAL_FORMAT',
      text: `!TST 10/001 ${sample.station} NAV DIFFERENT 2610041159-2610051200` }] })],
  ];
  for (const [reason, left, right] of cases) for (const pair of [[left, right], [right, left]] as const) {
    const { comparison, scopes } = evaluateNotamContent(...pair);
    assert.equal(scopes, undefined, reason);
    assert.ok(comparison.association?.outcome === 'unproven', reason);
    assert.ok(comparison.association.attempts.some(attempt => attempt.reason === reason), reason);
    assert.ok(comparison.fields.includes('icaoLocations'), reason);
    assert.equal(resolveNotamRevision(pair).kind, 'unresolved', reason);
    assert.ok(comparison.association.attempts.length <= 2);
  }
  const differentId = compareNotamScopes(a, changed(b, { id: b.id + '1' }));
  assert.deepEqual(differentId, { outcome: 'unproven', attempts: [{ witness: 'supplied-scopes', reason: 'source-id-mismatch' }] });
});

test('domestic and ICAO witnesses report their own limits and successful proof values', () => {
  const body = 'NAV TEST U/S', station = 'TST', fir = 'KZLA';
  const native = changed(b, { classification: 'DOMESTIC', series: '', number: '1', accountability: 'TST',
    locations: [station], icaoLocations: [station], text: body, translations: [
      { type: 'LOCAL_FORMAT', text: `!TST 10/001 TST ${body} 2610041159-2610051200` },
      { type: 'OTHER:ICAO', text: `10/001 NOTAMN Q) ${fir}/QXXXX/IV/BO/AE/000/999/3500N12000W005 A) ${fir} B) 2610041159 C) 2610051200 E) ${body}` },
    ] });
  const region = changed(native, { icaoLocations: [fir] });
  for (const [left, right, witness] of [[native, region, 'domestic'], [a, b, 'icao']] as const) {
    const { scopes, comparison } = evaluateNotamContent(left, right);
    assert.deepEqual(comparison.association, { outcome: 'proved', witness, scopes });
    assert.ok(scopes); assert.deepEqual(comparison.fields, []);
    const decision = resolveNotamRevision([left, right]); assert.equal(decision.kind, 'resolved');
    if (decision.kind === 'resolved') assert.deepEqual(decision.record.icaoLocations, scopes);
  }
  for (const [record, expected] of [
    [changed(region, { translations: region.translations.filter(t => t.type !== 'LOCAL_FORMAT') }), 'native-evidence-unproven'],
    [translation(region, ' E) NAV TEST U/S', ' E) NAV DIFFERENT'), 'native-conversion-unproven'],
  ] as const) {
    const result = compareNotamScopes(native, record); assert.ok(result.outcome === 'unproven');
    assert.deepEqual(result.attempts[0], { witness: 'domestic', reason: expected });
    assert.equal(resolveNotamRevision([native, record]).kind, 'unresolved');
  }
  const withoutIcao = [native, region].map(r => changed(r, { translations: r.translations.filter(t => t.type === 'LOCAL_FORMAT') }));
  assert.deepEqual(compareNotamScopes(withoutIcao[0]!, withoutIcao[1]!), { outcome: 'unproven', attempts: [
    { witness: 'domestic', reason: 'missing-fir-witness' }, { witness: 'icao', reason: 'missing-icao-witness' },
  ] });
});

test('health includes the evaluated association reason and leaves text-only or equal associations uncluttered', () => {
  const contrary = translation(b, `Q) ${sample.fir}`, 'Q) CZZZ');
  const issue = collectNotamRecords({ records: [] }, [a, contrary]).issues![0]!;
  const described = describeNotamIssue(issue, classifyNotamIssue(issue, a.updatedAt));
  assert.equal(described.blocking, true);
  assert.deepEqual(described.comparisons[0]!.association, evaluateNotamContent(a, contrary).comparison.association);
  assert.equal(evaluateNotamContent(a, changed(a, { text: a.text + ' DIFFERENT' })).comparison.association, undefined);
  assert.equal(evaluateNotamContent(a, changed(a, { icaoLocations: [] })).comparison.association, undefined);
  assert.equal(evaluateNotamContent(a, a).comparison.association, undefined);
});

test('different native numbering remains a constraint on corroborating local renderings', () => {
  const local = `!TST 10/001 ${sample.station} ${sample.full.text.slice(sample.station.length + 1)} 2610041159-2610051200`;
  const left = changed(a, { translations: [...a.translations, { type: 'LOCAL_FORMAT', text: local }] });
  const right = changed(b, { translations: [...b.translations, { type: 'LOCAL_FORMAT', text: local.replace('10/001', '10/002') }] });
  const comparison = compareNotamScopes(left, right);
  assert.ok(comparison.outcome === 'unproven');
  assert.ok(comparison.attempts.some(attempt => attempt.reason === 'local-content-mismatch'));
  assert.equal(resolveNotamRevision([left, right]).kind, 'unresolved');
});

test('a proved scope never overrides an independent unsupported local representation', () => {
  const local = `!TST 10/001 ${sample.station} ${sample.full.text.slice(sample.station.length + 1)} 2610041159-2610051200`;
  const left = changed(a, { translations: [...a.translations, { type: 'LOCAL_FORMAT', text: local }] });
  const right = changed(b, { translations: [...b.translations, { type: 'LOCAL_FORMAT', text: local.replaceAll('&', '&amp;') }] });
  const { comparison, scopes } = evaluateNotamContent(left, right);
  assert.ok(scopes); assert.equal(comparison.association?.outcome, 'proved');
  assert.deepEqual(comparison.fields, ['translations']);
  assert.equal(resolveNotamRevision([left, right]).kind, 'unresolved');
});
