import assert from 'node:assert/strict';
import test from 'node:test';
import { isNotamSourceIssue, type NotamRecord } from '@zlayer/contracts';
import fixture from './fixtures/notams-ewr-designator-2026-10-22.json';
import { aixm } from './fixtures/notams';
import { permutations, batchPartitions } from './helpers/permutations';
import { createNotamXmlParser, recordWithRevision } from '../tools/info-server/notams/normalize';
import { resolveNotamRevision, compareNotamContent } from '../tools/info-server/notams/revision';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { surfaceDesignatorEvidence } from '../src/layers/notams/notice-designators';

const issue = fixture.issues[0]!; assert.ok(isNotamSourceIssue(issue));
const [spaced, compact] = issue.variants as [NotamRecord, NotamRecord];
const changed = (r: NotamRecord, patch: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = r; return recordWithRevision({ ...facts, ...patch });
};
const textChanged = (r: NotamRecord, before: string, after: string) => changed(r, {
  text: r.text.replaceAll(before, after), translations: r.translations.map(t => ({ ...t, text: t.text.replaceAll(before, after) })),
});

test('captured EWR designator spacing resolves in both XML and stored forms, retaining all originals', () => {
  const parsed: NotamRecord[] = [];
  for (const r of issue.variants) {
    const parser = createNotamXmlParser(r => parsed.push(r), { count: 1, snapshotAt: fixture.checkedAt });
    parser.write(aixm(r)); parser.finish();
  }
  for (const variants of [issue.variants, parsed]) for (const order of permutations(variants)) {
    const saved = structuredClone(order), decision = resolveNotamRevision(order);
    assert.equal(decision.kind, 'resolved');
    if (decision.kind === 'resolved') {
      assert.ok(decision.proofs.includes('surface-designator-spacing'));
      assert.ok(decision.proofs.includes('source-year-omission'));
      assert.equal(decision.record.text, compact.text); assert.equal(decision.record.year, '2026');
      assert.equal(decision.record.updatedAt, spaced.updatedAt); assert.equal(decision.record.endsAt, spaced.endsAt);
      for (const t of variants.flatMap(r => r.translations)) assert.ok(decision.record.translations.some(v => v.type === t.type && v.text === t.text));
      assert.equal(collectNotamRecords({ records: [decision.record] }, order).issues?.length ?? 0, 0);
    }
    assert.deepEqual(order, saved);
  }
});

test('identifier slots are independent of airport, designator and other exact wording', () => {
  for (const word of ['TXL', 'TWY']) for (const id of ['B7', 'DD42', 'Z99']) for (const boundary of ['CLSD', 'WEST OF TXL F3 CLSD', 'BTN TWY D AND RWY 01 CLSD']) {
    const body = `${word === 'TXL' ? 'APRON TEST RAMP ' : ''}${word} ${id} ${boundary}`;
    const before = textChanged(spaced, spaced.text, body.replace(id, id.replace(/(\D+)(\d+)/, '$1 $2')));
    const after = textChanged(compact, compact.text, body);
    for (const order of permutations([before, after])) assert.equal(resolveNotamRevision(order).kind, 'resolved');
  }
});

test('designator equivalence preserves third contradictions through all orders, batches and rebasing', () => {
  const negative = [
    textChanged(compact, 'TXL A12', 'TXL A13'), textChanged(compact, 'WEST OF', 'EAST OF'),
    textChanged(compact, 'TXL F3', 'TXL F4'), textChanged(compact, 'CLSD', 'CLSD EXC EMERG'),
    textChanged(compact, 'CLSD', 'OPN'), textChanged(compact, 'TERMINAL A', 'TERMINAL B'),
    changed(compact, { endsAt: compact.endsAt! + 60_000, effectiveEnd: '202610221301' }),
    changed(compact, { lifecycle: 'unknown' }),
    changed(compact, { translations: [...compact.translations, { type: 'OTHER:UNKNOWN', text: compact.text }] }),
    changed(compact, { translations: compact.translations.map(t => t.type === 'OTHER:ICAO' ? { ...t, text: t.text.replace('QMNLC', 'QMNXX') } : t) }),
  ];
  const independent = changed(spaced, { id: '6692331137640167', sourceId: 'NMS_ID_6692331137640167' });
  for (const contrary of negative) for (const order of permutations([spaced, compact, contrary])) for (const batches of batchPartitions(order)) {
    let state: ReturnType<typeof collectNotamRecords> = { records: [independent] };
    for (const batch of batches) state = collectNotamRecords(state, batch);
    assert.equal(state.issues?.length, 1); assert.deepEqual(state.records, [independent]);
    assert.equal(collectNotamRecords(state, [spaced, compact]).issues?.length, 1);
    assert.equal(rebaseNotamRecords(state, [compact, independent], fixture.checkedAt).issues?.length, 1);
  }
});

test('unknown boundaries, distances, lists, other identifiers and incomplete witnesses cannot authorize joining', () => {
  for (const [a, b] of [
    ['TXL A 12FT WEST', 'TXL A12FT WEST'], ['TXL A 12 FT WEST', 'TXL A12 FT WEST'],
    ['TXL A, 12 WEST', 'TXL A12 WEST'], ['TXL A 12, WEST', 'TXL A12, WEST'],
    ['TXL A 12 AND', 'TXL A12 AND'], ['TXL A 012 WEST', 'TXL A012 WEST'],
    ['TXL ABC 12 WEST', 'TXL ABC12 WEST'], ['TXL A 123 WEST', 'TXL A123 WEST'],
    ['RWY A 12 WEST', 'RWY A12 WEST'], ['GATE A 12 WEST', 'GATE A12 WEST'],
    ['TXL A 12 UNKNOWN', 'TXL A12 UNKNOWN'],
  ] as const) {
    const before = textChanged(spaced, 'TXL A 12 WEST', a), after = textChanged(compact, 'TXL A12 WEST', b);
    assert.equal(resolveNotamRevision([before, after]).kind, 'unresolved', a);
  }
  for (const patch of [
    { classification: 'INTL' }, { changeType: 'R' }, { translations: [] },
    { translations: spaced.translations.map(t => ({ ...t, text: t.text.replace('!EWR', '!XXX') })) },
    { translations: spaced.translations.map(t => ({ ...t, text: t.text.replace('2610220100', '2610220101') })) },
  ] as Partial<NotamRecord>[]) {
    assert.equal(surfaceDesignatorEvidence([changed(spaced, patch), compact]), undefined);
  }
  assert.equal(resolveNotamRevision([changed(spaced, { translations: [] }), compact]).kind, 'unresolved');
  assert.equal(collectNotamRecords({ records: [], issues: [{ ...issue, variantsTruncated: true }] }, [spaced, compact]).issues?.length, 1);
  const overflow = changed(compact, { translations: [...compact.translations, ...Array.from({ length: 6 }, (_, i) => ({
    ...compact.translations[0]!, text: compact.translations[0]!.text + ' '.repeat(i + 1),
  }))] });
  const result = resolveNotamRevision([spaced, overflow]);
  assert.equal(result.kind, 'unresolved'); if (result.kind === 'unresolved') assert.equal(result.reason, 'representation-limit');
  assert.deepEqual(compareNotamContent(spaced, compact).fields, []);
});
