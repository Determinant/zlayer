import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNotamRecord, isNotamSourceIssue, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import dwh from './fixtures/notams-cancellation-2026-10-18.json';
import notamc from './fixtures/notams-notamc-2026-10-18.json';
import separateLimits from './fixtures/notams-separate-limits-2026-10-19.json';
import { icaoEvidence } from '../src/layers/notams/notice-evidence';
import intl from './fixtures/notams-rkti-2026-10-11.json';
import schedules from './fixtures/notams-schedule-2026-10-13.json';
import scopes from './fixtures/notams-state-2026-10-16.json';
import ewr from './fixtures/notams-ewr-designator-2026-10-22.json';
import fim from './fixtures/notams-fim-association-2026-10-22.json';
import fra from './fixtures/notams-fra-association-2026-10-28.json';
import { aixm, departureNotice, notice } from './fixtures/notams';
import { fdcHeaderCases, localGrammarNotice } from './fixtures/notams-local-grammar';
import { permutations, batchPartitions } from './helpers/permutations';
import { recordWithRevision, createNotamXmlParser } from '../tools/info-server/notams/normalize';
import { compareNotamContent, resolveNotamRevision } from '../tools/info-server/notams/revision';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { NotamStore } from '../tools/info-server/notams/store';
import { createInfoServer } from '../tools/info-server/server';

const record = (value: unknown): NotamRecord => { assert.ok(isNotamRecord(value)); return value; };
const changed = (record: NotamRecord, fields: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = record; return recordWithRevision({ ...facts, ...fields });
};
const original: NotamSourceIssue = (() => { const value: unknown = dwh.issues[0]; assert.ok(isNotamSourceIssue(value)); return value; })();
const ewrIssue: NotamSourceIssue = (() => { const value: unknown = ewr.issues[0]; assert.ok(isNotamSourceIssue(value)); return value; })();
const active = original.variants.find(r => r.lifecycle === 'active')!;
const cancelled = original.variants.find(r => r.lifecycle === 'cancelled')!;
const cancel = (r: NotamRecord) => changed(r, { lifecycle: 'cancelled', canceledAt: r.sourceUpdatedAt });

function assertSequence(variants: NotamRecord[], lifecycle: NotamRecord['lifecycle']) {
  let result: ReturnType<typeof collectNotamRecords> = { records: [] };
  for (const order of permutations(variants)) for (const batches of batchPartitions(order)) {
    let collection: ReturnType<typeof collectNotamRecords> = { records: [] };
    for (const batch of batches) collection = collectNotamRecords(collection, batch);
    assert.equal(collection.issues?.length ?? 0, 0);
    assert.equal(collection.records.length, 1);
    const resolved = collection.records[0]!;
    assert.ok(isNotamRecord(resolved)); assert.equal(resolved.lifecycle, lifecycle);
    assert.equal(resolved.updatedAt, variants[0]!.updatedAt);
    assert.equal(resolved.year, variants.find(r => r.year)!.year);
    const repeat = collectNotamRecords(collection, [...order, ...order]);
    assert.equal(repeat, collection, 'repeated delivery is idempotent');
    const sparse = changed(resolved, { translations: [], icaoLocations: [] });
    assert.equal(collectNotamRecords(collection, [sparse]).issues?.length ?? 0, 0);
    assert.equal(rebaseNotamRecords(collection, [variants[0]!], resolved.updatedAt).issues?.length ?? 0, 0);
    result = collection;
  }
  return result.records[0]!;
}

test('specified local headers compose with body wrappers, years, counters, UTC forms and cancellation', () => {
  for (const header of fdcHeaderCases) for (const end of ['2610051200', '2610051200EST', 'PERM']) {
    const { record: full, withoutSubject, interval } = localGrammarNotice(header, end);
    for (let mask = 0; mask < 16; mask++) {
      const brief = changed(full, { year: mask & 1 ? '' : full.year,
        text: `${mask & 2 ? full.text : withoutSubject}${mask & 4 ? ` ${interval.replace('-', ' - ')}` : ''}`,
        number: '001001', icaoLocations: [], sequence: 3, correction: 2,
        effectiveStart: new Date(full.startsAt!).toISOString(),
        translations: full.translations.map(t => ({ ...t, text: mask & 8
          ? `<pre>\n${t.text.replace(interval, interval.replace('-', ' - ')).replaceAll(' ', '\n  ')}\n</pre>` : t.text })),
      });
      const xml: NotamRecord[] = [];
      for (const r of [full, brief]) {
        const parser = createNotamXmlParser(r => xml.push(r), { count: 1, snapshotAt: full.updatedAt });
        parser.write(aixm(r)); parser.finish();
      }
      for (const pair of [[full, brief], xml]) {
        try {
          const resolved = assertSequence(pair, 'active');
          assertSequence([pair[0]!, cancel(pair[1]!)], 'cancelled');
          for (const translation of pair.flatMap(r => r.translations))
            assert.ok(resolved.translations.some(t => t.text === translation.text));
          assert.deepEqual(resolved.sourceCounters, [{ sequence: 1, correction: 0 }, { sequence: 3, correction: 2 }]);
        } catch (cause) { throw new Error(JSON.stringify({ header, end, mask, xml: pair === xml,
          decision: compareNotamContent(pair[0]!, pair[1]!) }), { cause }); }
      }
    }
  }
});

test('captured DWH cancellation composes with witnessed year omission through XML, ordering and batching', () => {
  const parsed: NotamRecord[] = [];
  original.variants.forEach(r => {
    const parser = createNotamXmlParser(r => parsed.push(r), { count: 1, snapshotAt: dwh.checkedAt });
    parser.write(aixm(r)); parser.finish();
  });
  for (const variants of [original.variants, parsed]) {
    const resolved = assertSequence(variants, 'cancelled');
    assert.equal(resolved.canceledAt, cancelled.canceledAt);
    assert.deepEqual(resolved.sourceYears, ['', '2026']);
    const decision = resolveNotamRevision(variants); assert.equal(decision.kind, 'resolved');
    if (decision.kind === 'resolved') {
      assert.ok(decision.proofs.includes('source-year-omission'));
      assert.ok(decision.proofs.includes('positive-cancellation'));
    }
  }
});

const separateLimitIssues = separateLimits.issues.map((value): NotamSourceIssue => {
  assert.ok(isNotamSourceIssue(value)); return value;
});
test('captured AIXM E-only bodies compose with numbering years and foreign annotations through XML and batching', () => {
  for (const issue of separateLimitIssues) {
    const parsed: NotamRecord[] = [];
    for (const r of issue.variants) {
      const parser = createNotamXmlParser(r => parsed.push(r), { count: 1, snapshotAt: separateLimits.checkedAt });
      parser.write(aixm(r)); parser.finish();
    }
    for (const variants of [issue.variants, parsed]) {
      variants.forEach(value => assert.equal(icaoEvidence(value), undefined));
      const resolved = assertSequence(variants, 'active');
      assertSequence(variants.map(cancel), 'cancelled');
      assert.equal(resolved.text, variants[0]!.text);
      for (const translation of variants.flatMap(r => r.translations))
        assert.ok(resolved.translations.some(t => t.type === translation.type && t.text === translation.text));
      const comparison = compareNotamContent(variants[0]!, variants[1]!);
      assert.deepEqual(comparison.fields, []);
      if (issue.locations.includes('LSF')) assert.deepEqual(resolved.sourceYears, ['', '2026']);
      else assert.equal(comparison.text.proof, 'icao-distribution-annotation');
      // Reconciliation must not broaden the PWA's existing rendered-body proof,
      // including after the same record was cached by source comparison.
      assert.equal(icaoEvidence(variants[1]!), undefined);
    }
  }
});

test('separate limits compose across E-only and E-through-G bodies, field spacing, schedules and omissions', () => {
  for (const issue of separateLimitIssues) {
    const base = issue.variants.find(r => r.year && !r.translations.some(t => t.text.includes('DISCLAIMS')))
      ?? issue.variants.find(r => r.year)!;
    const translation = base.translations.find(t => t.type === 'OTHER:ICAO')!.text.replace(/\s+F\)[\s\S]*$/, '');
    for (const limits of ['', ' F) SFC', ' G) 10000FT AGL', ' F) SFC G) 10000FT AGL'])
      for (const compact of [false, true]) for (let mask = 0; mask < 8; mask++) {
        const text = translation + limits;
        const full = changed(base, { text: base.text + limits, translations: [{ type: 'OTHER:ICAO', text }] });
        const separate = changed(base, { year: mask & 1 ? '' : base.year, schedule: mask & 2 ? '' : base.schedule,
          icaoLocations: mask & 4 ? [] : base.icaoLocations,
          translations: [{ type: 'OTHER:ICAO', text: compact ? text.replace(/([A-GQ]\))\s*/g, '$1') : text }] });
        const resolved = assertSequence([full, separate], 'active');
        assert.equal(resolved.text, base.text);
        assert.equal(resolved.schedule, base.schedule);
        assert.equal(resolved.year, base.year);
      }
  }
});

test('separate E text never erases supplied limits, partial bodies, changed datums or a contradictory third rendering', () => {
  for (const issue of separateLimitIssues) {
    const base = issue.variants[1]!;
    const mutate = (fn: (text: string) => string) => changed(base, { translations: base.translations.map(t =>
      t.type === 'OTHER:ICAO' ? { ...t, text: fn(t.text) } : t) });
    const negatives = [
      mutate(text => text.replace(/F\)\s*(SFC|GND)/, 'F) 100FT AGL')),
      mutate(text => text.replace('FT AGL', 'FT AMSL')),
      mutate(text => text.replace(/G\)\s*(10000|400)FT/, 'G) 500FT')),
      mutate(text => text.replace(/\s+F\)\s*(SFC|GND)/, '')),
      mutate(text => text.replace(/\s+G\)\s*\d+FT AGL/, '')),
      changed(base, { text: base.text + ' F) SFC' }),
      changed(base, { text: base.text + ' EXC EMERGENCY' }),
      changed(base, { translations: [...base.translations, { type: 'OTHER:ICAO', text: 'UNKNOWN' }] }),
    ];
    for (const contrary of negatives) for (const order of permutations([...issue.variants, contrary]))
      for (const batches of batchPartitions(order)) {
        let state: ReturnType<typeof collectNotamRecords> = { records: [] };
        for (const batch of batches) state = collectNotamRecords(state, batch);
        assert.equal(state.issues?.length, 1); assert.equal(state.records.length, 0);
        assert.equal(collectNotamRecords(state, issue.variants).issues?.length, 1);
      }
  }
});

const cancellationIssue: NotamSourceIssue = (() => { const value: unknown = notamc.issues[0]; assert.ok(isNotamSourceIssue(value)); return value; })();
const cancellationPair = cancellationIssue.variants;
test('structured representation changes compose with NOTAMC identity and retained references', () => {
  const full = changed(cancellationPair[0]!, { locations: [...cancellationPair[0]!.locations, 'ZZX'] });
  const brief = changed(cancellationPair[1]!, { locations: [...full.locations].reverse(),
    effectiveStart: new Date(full.startsAt!).toISOString() });
  assertSequence([full, brief], 'cancellation');
  const contrary = changed(brief, { referred: { series: 'M', number: '729', year: '2026' } });
  for (const order of permutations([full, brief, contrary])) for (const batches of batchPartitions(order)) {
    let state: ReturnType<typeof collectNotamRecords> = { records: [] };
    for (const batch of batches) state = collectNotamRecords(state, batch);
    assert.equal(state.issues?.length, 1); assert.equal(state.records.length, 0);
  }
});
test('captured NOTAMC identity composes with missing years, terse renderings and sparse repeats', () => {
  assert.ok(isNotamSourceIssue(cancellationIssue));
  const parsed: NotamRecord[] = [];
  for (const r of cancellationPair) {
    const parser = createNotamXmlParser(r => parsed.push(r), { count: 1, snapshotAt: notamc.checkedAt });
    parser.write(aixm(r)); parser.finish();
  }
  for (const variants of [cancellationPair, parsed]) {
    for (let mask = 0; mask < 32; mask++) {
      const [full, brief] = variants as [NotamRecord, NotamRecord];
      const sparse = changed(brief, {
        year: mask & 1 ? '' : brief.year,
        number: mask & 2 ? brief.number.padStart(5, '0') : brief.number,
        translations: mask & 4 ? [] : brief.translations,
        icaoLocations: mask & 8 ? [] : brief.icaoLocations,
        ...(mask & 16 ? { sequence: 2, correction: 1, issuedAt: brief.updatedAt + 1000 } : {}),
      });
      const resolved = assertSequence([full, brief, sparse], 'cancellation');
      assert.deepEqual(resolved.sourceYears, ['', '2026']);
      assert.deepEqual(resolved.referred, full.referred);
      for (const translation of full.translations) assert.ok(resolved.translations.some(t => t.text === translation.text));
    }
  }
});

test('NOTAMC omission proof cannot hide a conflicting header, reference, year or lifecycle', () => {
  const [full, brief] = cancellationPair as [NotamRecord, NotamRecord];
  const replacement = (from: string, to: string) => changed(brief, { text: brief.text.replaceAll(from, to),
    translations: brief.translations.map(t => ({ ...t, text: t.text.replaceAll(from, to) })) });
  for (const contrary of [replacement('M0730/26', 'M0731/26'), replacement('M0728/26', 'M0729/26'),
    replacement('NOTAMC', 'NOTAMR'), changed(brief, { year: '2025' }), changed(brief, { lifecycle: 'active' }),
    changed(brief, { referred: { series: 'M', number: '729', year: '2026' } }),
    changed(brief, { referred: { series: 'M', number: '728', year: '2126' } })]) {
    for (const order of permutations([full, brief, contrary])) for (const batches of batchPartitions(order)) {
      let state: ReturnType<typeof collectNotamRecords> = { records: [] };
      for (const batch of batches) state = collectNotamRecords(state, batch);
      assert.equal(state.issues?.length, 1); assert.equal(state.records.length, 0);
      assert.equal(collectNotamRecords(state, cancellationPair).issues?.length, 1);
    }
  }
  const sparse = changed(brief, { year: '' });
  assert.equal(resolveNotamRevision([sparse, brief]).kind, 'unresolved', 'a header alone is not a complete year witness');
  for (const text of [full.translations[0]!.text + ' Q) UNKNOWN',
    full.translations[0]!.text.replace('B) 2610182039', 'B) 2610182040'),
    full.translations[0]!.text.replace('E)', 'C) 2610212039 E)')]) {
    assert.equal(resolveNotamRevision([changed(full, { translations: [{ type: 'OTHER:ICAO', text }] }), brief]).kind, 'unresolved');
  }
  const independent = changed(full, { id: '1792355985226702', sourceId: 'NMS_ID_1792355985226702', year: '2026',
    number: '728', changeType: 'N', lifecycle: 'active' });
  const collection = collectNotamRecords({ records: [independent] }, cancellationPair);
  assert.equal(collection.records.find(r => r.id === independent.id)?.lifecycle, 'active');
  assert.equal(collectNotamRecords({ records: [], issues: [{ ...cancellationIssue, variantsTruncated: true }] }, cancellationPair).issues?.length, 1);
  const many = changed(full, { year: '2026', translations: Array.from({ length: 8 }, (_, i) => ({
    ...full.translations[0]!, text: full.translations[0]!.text + ' '.repeat(i),
  })) });
  const reordered = changed(many, { translations: many.translations.map(({ type, text }) => ({ text, type })) });
  assert.equal(resolveNotamRevision([many, reordered]).kind, 'resolved', 'serialization key order adds no translation evidence');
  const overflow = resolveNotamRevision([many, brief]);
  assert.equal(overflow.kind, 'unresolved');
  if (overflow.kind === 'unresolved') assert.equal(overflow.reason, 'representation-limit');
});

test('a cancellation reference carried only by primary text survives terse observations', () => {
  const brief = changed(cancellationPair[1]!, { translations: [] });
  const terse = changed(brief, { text: 'CANCELED' });
  const contrary = changed(brief, { text: brief.text.replace('M0728/26', 'M0729/26') });
  for (const order of permutations([brief, terse, contrary])) for (const batches of batchPartitions(order)) {
    let state: ReturnType<typeof collectNotamRecords> = { records: [] };
    for (const batch of batches) state = collectNotamRecords(state, batch);
    assert.equal(state.issues?.length, 1);
  }
  for (const order of permutations([brief, terse])) {
    const decision = resolveNotamRevision(order); assert.equal(decision.kind, 'resolved');
    if (decision.kind === 'resolved') {
      assert.equal(decision.record.text, brief.text);
    }
  }
});

test('NOTAMC headers constrain the year even when both structured years are missing', () => {
  const missing = changed(cancellationPair[1]!, { year: '', translations: [] });
  const contrary = changed(missing, { text: missing.text.replace('M0730/26', 'M0730/27') });
  const supplied = changed(cancellationPair[0]!, { year: '2026' });
  for (const variants of [[missing, contrary], [missing, contrary, supplied]]) {
    for (const order of permutations(variants)) for (const batches of batchPartitions(order)) {
      let state: ReturnType<typeof collectNotamRecords> = { records: [] };
      for (const batch of batches) state = collectNotamRecords(state, batch);
      assert.equal(state.issues?.length, 1); assert.equal(state.records.length, 0);
      assert.equal(collectNotamRecords(state, cancellationPair).issues?.length, 1);
    }
  }
});

test('NOTAMC diagnostics expose header contradictions even when raw content is repeated', () => {
  const invalid = changed(cancellationPair[1]!, { text: 'M0730/27 NOTAMC M0728/26', translations: [] });
  const repeated = changed(invalid, { correction: invalid.correction + 1 });
  const decision = resolveNotamRevision([invalid, repeated]);
  assert.equal(decision.kind, 'unresolved');
  const comparison = compareNotamContent(invalid, repeated);
  assert.equal(comparison.outcome, 'contradictory'); assert.ok(comparison.fields.includes('text'));
  if (decision.kind === 'unresolved') assert.deepEqual(decision.conflicts[0]!.comparison, comparison);
});

test('NOTAMC referenced identifiers normalize decimal padding only', () => {
  const base = changed(cancellationPair[1]!, { text: 'CANCELED', translations: [],
    referred: { series: 'M', number: '00728/1', year: '2026' } });
  const contrary = changed(base, { referred: { ...base.referred!, number: '728/1' } });
  for (const order of permutations([base, contrary])) assert.equal(resolveNotamRevision(order).kind, 'unresolved');
});

// Source profiles are retained examples; the cross-product transformations below
// are invented. The oracle is the specified identity/lifecycle, not the comparator.
const profiles = [changed(active, { year: '2026' }), record(departureNotice()), record(intl.issues[0]!.variants[0]),
  ...schedules.issues.map(issue => record(issue.variants[0]))];
for (const profile of profiles) test(`representation/lifecycle composition matrix: ${profile.classification} ${profile.locations[0]}`, () => {
  const base = changed(profile, { locations: [...profile.locations, 'ZZX'], icaoLocations: [...profile.icaoLocations, 'KZZX'] });
  for (let mask = 0; mask < 256; mask++) {
    const variant = changed(base, {
      year: mask & 1 ? '' : base.year,
      number: mask & 2 ? base.number.padStart(5, '0') : base.number,
      ...(mask & 4 ? { sequence: base.sequence + 1, correction: base.correction + 2 } : {}),
      locations: mask & 64 ? [...base.locations].reverse() : base.locations,
      icaoLocations: mask & 8 ? [] : mask & 64 ? [...base.icaoLocations].reverse() : base.icaoLocations,
      translations: mask & 16 ? base.translations.map(t => ({ ...t, text: `\n ${t.text.replace(/ /g, '  ')}\n` })) : base.translations,
      ...(mask & 32 ? { issuedAt: (base.issuedAt ?? base.updatedAt) + 1000, sourceUpdatedAt: base.sourceUpdatedAt.replace('.000Z', 'Z') } : {}),
      ...(mask & 128 ? { effectiveStart: base.startsAt === null ? base.effectiveStart : new Date(base.startsAt).toISOString(),
        effectiveEnd: base.endsAt === null ? base.effectiveEnd : new Date(base.endsAt).toISOString() } : {}),
    });
    for (const lifecycle of ['active', 'left-cancelled', 'right-cancelled', 'both-cancelled']) {
      const before = lifecycle === 'left-cancelled' || lifecycle === 'both-cancelled' ? cancel(base) : base;
      const after = lifecycle === 'right-cancelled' || lifecycle === 'both-cancelled' ? cancel(variant) : variant;
      try { assertSequence([before, after], lifecycle === 'active' ? 'active' : 'cancelled'); }
      catch (error) { throw new Error(`mask=${mask}, lifecycle=${lifecycle}`, { cause: error }); }
    }
  }
});

test('captured designator spellings compose with identity, omissions, counters, UTC forms and cancellation', () => {
  const [spaced, compact] = ewr.issues[0]!.variants.map(record) as [NotamRecord, NotamRecord];
  for (let mask = 0; mask < 64; mask++) {
    const before = changed(spaced, { locations: [...spaced.locations, 'ZZX'] });
    const after = changed(compact, {
      year: mask & 1 ? '2026' : '', number: mask & 2 ? '00178' : compact.number,
      ...(mask & 4 ? { sequence: compact.sequence + 1, correction: compact.correction + 2 } : {}),
      icaoLocations: mask & 8 ? [] : compact.icaoLocations,
      translations: compact.translations.filter(t => !(mask & 16) || t.type === 'LOCAL_FORMAT').map(t =>
        mask & 2 && t.type === 'LOCAL_FORMAT' ? { ...t, text: t.text.replace('10/178', '10/00178') } : t),
      locations: ['ZZX', ...compact.locations], effectiveStart: new Date(compact.startsAt!).toISOString(),
      ...(mask & 32 ? { issuedAt: compact.issuedAt! + 1000, sourceUpdatedAt: compact.sourceUpdatedAt.replace('.000Z', 'Z') } : {}),
    });
    for (const lifecycle of ['active', 'left-cancelled', 'right-cancelled', 'both-cancelled']) {
      const left = lifecycle === 'left-cancelled' || lifecycle === 'both-cancelled' ? cancel(before) : before;
      const right = lifecycle === 'right-cancelled' || lifecycle === 'both-cancelled' ? cancel(after) : after;
      try { assertSequence([left, right], lifecycle === 'active' ? 'active' : 'cancelled'); }
      catch (error) { throw new Error(`designator mask=${mask}, lifecycle=${lifecycle}`, { cause: error }); }
    }
  }
});

test('year, schedule and complementary-scope proofs compose across three observations and lifecycle transitions', () => {
  for (const issue of [...schedules.issues, ...scopes.issues.slice(1), ...fim.issues, ...fra.issues]) {
    const [a, b] = issue.variants.map(record) as [NotamRecord, NotamRecord];
    const missing = changed(b, { year: '' });
    assertSequence([a, b, missing], 'active');
    assertSequence([a, missing, cancel(b)], 'cancelled');
    // Once established, identity survives a terse original-ID cancellation and
    // a subsequent sparse replay. It is independent of the display body.
    const agreed = collectNotamRecords({ records: [] }, [a, missing]);
    assert.equal(agreed.issues?.length ?? 0, 0);
    const terse = changed(cancel(b), { text: 'CANCELED', translations: [] });
    const inactive = collectNotamRecords(agreed, [terse]);
    const replayed = collectNotamRecords(inactive, [changed(missing, { translations: [] })]);
    assert.equal(replayed.issues?.length ?? 0, 0); assert.equal(replayed.records[0]?.lifecycle, 'cancelled');
    assert.deepEqual(replayed.records[0]?.sourceYears, ['', b.year]);
  }
});

test('ICAO station/FIR roles compose with source omissions, counters, lexical forms and cancellation', () => {
  const [a, b] = fra.issues[0]!.variants.map(record) as [NotamRecord, NotamRecord];
  for (let mask = 0; mask < 64; mask++) {
    const partial = changed(b, { year: mask & 1 ? '' : b.year, number: mask & 2 ? b.number.padStart(6, '0') : b.number,
      ...(mask & 4 ? { sequence: 3, correction: 2 } : {}), icaoLocations: mask & 8 ? [] : b.icaoLocations,
      translations: mask & 16 ? [] : b.translations.map(t => ({ ...t, text: `\n ${t.text.replaceAll(' ', '  ')}\n` })),
      ...(mask & 32 ? { effectiveStart: new Date(b.startsAt!).toISOString(), effectiveEnd: new Date(b.endsAt!).toISOString(),
        sourceUpdatedAt: b.sourceUpdatedAt.replace('.000Z', 'Z'), issuedAt: b.issuedAt! + 1000 } : {}),
    });
    try {
      const resolved = assertSequence([a, b, partial], 'active');
      assert.deepEqual(resolved.icaoLocations, ['FRA', 'KZOA']);
      assertSequence([a, partial, cancel(b)], 'cancelled');
    } catch (cause) { throw new Error(`ICAO station/FIR mask=${mask}`, { cause }); }
  }
});

test('station/FIR roles compose with omissions, padding, counters, UTC forms, sparse replay and cancellation', () => {
  const [a, b] = fim.issues[0]!.variants.map(record) as [NotamRecord, NotamRecord];
  for (let mask = 0; mask < 64; mask++) {
    const partial = changed(b, { year: mask & 1 ? '' : b.year, number: mask & 2 ? b.number.padStart(5, '0') : b.number,
      ...(mask & 4 ? { sequence: 2, correction: 1 } : {}),
      icaoLocations: mask & 8 ? [] : b.icaoLocations,
      translations: mask & 16 ? [] : b.translations.map(t => ({ ...t, text: `\n ${(mask & 2 && t.type === 'LOCAL_FORMAT'
        ? t.text.replace('10/125', '10/00125') : t.text).replaceAll(' ', '  ')}\n` })),
      ...(mask & 32 ? { effectiveStart: new Date(b.startsAt!).toISOString(),
        sourceUpdatedAt: b.sourceUpdatedAt.replace('.000Z', 'Z'), issuedAt: b.issuedAt! + 1000 } : {}),
    });
    try {
      const resolved = assertSequence([a, b, partial], 'active');
      assert.deepEqual(resolved.icaoLocations, ['KFIM', 'KZLA']);
      assertSequence([a, partial, cancel(b)], 'cancelled');
    } catch (cause) { throw new Error(`station/FIR mask=${mask}`, { cause }); }
  }
});

test('complete identity evidence survives sparse observations and terse cancellations in every partition', () => {
  const base = changed(active, { year: '2026' });
  const terse = changed(cancelled, { text: 'CANCELED', translations: [] });
  assertSequence([active, base, terse], 'cancelled');
  assertSequence([changed(active, { translations: [] }), base, terse], 'cancelled');
  assertSequence([active, changed(base, { translations: [] })], 'active');
  assertSequence([base, changed(terse, { year: '' })], 'cancelled');
  const unknown = [active, base].map(r => changed(r, { translations: [] }));
  assert.equal(resolveNotamRevision(unknown).kind, 'unresolved', 'an omission still requires complete identity evidence');
});

test('schedule omissions compose with complete-set code qualification in every arrival order and batch', () => {
  const base = record(intl.issues[0]!.variants[0]);
  const variant = (code: string, schedule = 'DAILY 2300-0900') => changed(base, {
    text: 'AD CLSD', schedule, translations: [{ type: 'OTHER:ICAO', text:
      `M0398/26 NOTAMN Q) RKRR/${code}/IV/NBO/A/000/999/3702N12753E005 ` +
      'A) RKTI B) 2610162300 C) 2610170900 D) DAILY 2300-0900 E) AD CLSD' }],
  });
  const sparse = variant('QXXXX', ''), wrong = variant('QMNLC');
  const confirming = variant('QFALC'), scheduled = variant('QXXXX');
  assert.equal(resolveNotamRevision([sparse, wrong]).kind, 'unresolved');
  assert.equal(resolveNotamRevision([sparse, scheduled, wrong]).kind, 'unresolved');
  assertSequence([sparse, confirming], 'active');
  assertSequence([changed(sparse, { year: '' }), wrong, confirming, scheduled], 'active');
  const alternate = changed(confirming, { schedule: 'DLY 2300-0900', translations: confirming.translations.map(t => ({
    ...t, text: t.text.replace('DAILY', 'DLY').replace('/NBO/', '/BO/'),
  })) });
  assertSequence([sparse, wrong, alternate, scheduled], 'active');
  const resolved = assertSequence([sparse, wrong, confirming, scheduled], 'active');
  assert.equal(resolved.schedule, scheduled.schedule);
  for (const source of [sparse, wrong, confirming, scheduled])
    assert.ok(resolved.translations.some(t => t.text === source.translations[0]!.text));
  for (const contrary of [changed(wrong, { schedule: 'DAILY 0000-0100' }),
    changed(wrong, { translations: wrong.translations.map(t => ({ ...t, text: t.text.replace('2300-0900', '2301-0900') })) }),
    changed(confirming, { translations: confirming.translations.map(t => ({ ...t, text: t.text.replace('AD CLSD', 'AD CLSD EXC EMERGENCY') })) })]) {
    for (const order of permutations([sparse, confirming, contrary]))
      assert.equal(resolveNotamRevision(order).kind, 'unresolved', 'qualification cannot erase a supplied schedule or body contradiction');
  }
});

test('every supplied identity remains a constraint, including third observations and duplicate inactive records', () => {
  const base = changed(active, { year: '2026' });
  for (const patch of [{ year: '2025' }, { number: '999' }, { series: 'X' }, { classification: 'FDC' }, { changeType: 'R' }] as Partial<NotamRecord>[]) {
    for (const lifecycle of ['active', 'cancelled'] as const) {
      const contrary = changed(lifecycle === 'cancelled' ? cancel(base) : base, patch);
      for (const order of permutations([base, cancel(base), contrary])) for (const batches of batchPartitions(order)) {
        let state: ReturnType<typeof collectNotamRecords> = { records: [] };
        for (const batch of batches) state = collectNotamRecords(state, batch);
        assert.equal(state.issues?.length, 1, JSON.stringify(patch)); assert.equal(state.records.length, 0);
        assert.equal(collectNotamRecords(state, [base, cancel(base)]).issues?.length, 1);
      }
    }
  }
});

test('identity proof grants no cancellation authority, body correction, new revision or overflow exception', () => {
  const base = changed(active, { year: '2026' });
  const negatives = [changed(cancelled, { canceledAt: '' }),
    changed(cancelled, { canceledAt: new Date(cancelled.updatedAt - 1).toISOString() }),
    changed(cancelled, { lifecycle: 'cancellation', changeType: 'C' }),
    changed(cancelled, { lifecycle: 'unknown' }), changed(base, { text: `${base.text} EXC EMERGENCY` })];
  for (const contrary of negatives) for (const order of permutations([active, base, contrary])) {
    assert.equal(collectNotamRecords({ records: [] }, order).issues?.length, 1);
  }
  const resolved = collectNotamRecords({ records: [] }, [active, cancelled]);
  const newer = changed(base, { updatedAt: base.updatedAt + 1000, sourceUpdatedAt: new Date(base.updatedAt + 1000).toISOString() });
  const replacement = collectNotamRecords(resolved, [newer]);
  assert.deepEqual(replacement.records, [newer]);
  assert.equal(collectNotamRecords(replacement, original.variants), replacement);
  assert.equal(collectNotamRecords({ records: [], issues: [{ ...original, variantsTruncated: true }] }, [cancelled]).issues?.length, 1);
  const independent = changed(base, { id: '9745974410620577', sourceId: 'NMS_ID_9745974410620577' });
  const separate = collectNotamRecords(resolved, [independent]);
  assert.equal(separate.records.find(r => r.id === independent.id)?.lifecycle, 'active');
});

const structuredBase = changed(notice(), { locations: ['TST', 'ZZX'] });
const structuredVariant = changed(structuredBase, { locations: ['ZZX', 'TST'],
  effectiveStart: '2026-10-04T11:59:00.000000000Z', effectiveEnd: '2026-10-05T12:00:00Z' });
const structuredIssue: NotamSourceIssue = { id: structuredBase.id, reason: 'revision-conflict', variants: [structuredBase, structuredVariant],
  variantsTruncated: false, locations: structuredBase.locations, icaoLocations: structuredBase.icaoLocations, unscoped: false };
for (const fixture of [{ issue: structuredIssue, checkedAt: structuredBase.updatedAt, selectors: ['faaId=TST', 'faaId=ZZX', 'icaoId=KTST'] },
  { issue: ewrIssue, checkedAt: ewr.checkedAt, selectors: ['faaId=EWR', 'icaoId=KEWR'] },
  { issue: original, checkedAt: dwh.checkedAt, selectors: ['faaId=DWH', 'icaoId=KDWH'] },
  { issue: cancellationIssue, checkedAt: notamc.checkedAt, selectors: ['icaoId=OJKF'] },
  ...separateLimitIssues.map(issue => ({ issue, checkedAt: separateLimits.checkedAt, selectors: issue.icaoLocations.map(code => `icaoId=${code}`) }))])
test(`authenticated recovery publishes ${fixture.issue.id} without freshening clocks or admission`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-composition-')), state = join(directory, 'production');
  const at = fixture.checkedAt, store = new NotamStore(state, 'production', () => at);
  await store.restore(); await store.admission.reserve('bulk');
  await store.publish({ schemaVersion: 2, environment: 'production', records: [], issues: [fixture.issue],
    complete: true, checkedAt: at, watermark: at, fullSyncAt: at, baselineAt: at });
  await store.close();
  const budget = await readFile(join(state, 'budget.json'));
  let calls = 0;
  const open = () => createInfoServer({ directory: join(directory, 'weather'), startUpdates: false, now: () => at,
    notams: { enabled: true, environment: 'production', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
    fetch: async () => { calls++; throw Error('No source requests'); } });
  try {
    for (let restart = 0; restart < 2; restart++) {
      const app = await open();
      try {
        await app.notams.restore();
        await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
        const address = app.server.address(); assert.ok(address && typeof address !== 'string');
        const origin = `http://127.0.0.1:${address.port}`;
        for (const selector of fixture.selectors) {
          const path = `/api/notams/airports?${selector}`;
          const response = await fetch(origin + path); assert.equal(response.status, 200);
          const snapshot = await response.json();
          assert.equal(snapshot.contentCoverage, 'complete'); assert.deepEqual(snapshot.issues, []);
          if (fixture.issue.variants[0]!.lifecycle === 'active' && fixture.issue.variants.every(r => r.lifecycle === 'active')) {
            assert.equal(snapshot.records.length, 1); assert.equal(snapshot.records[0].id, fixture.issue.id);
          } else assert.deepEqual(snapshot.records, []);
          assert.equal(snapshot.feed.state, 'ready');
          assert.equal(snapshot.feed.checkedAt, at); assert.equal(snapshot.feed.watermark, at); assert.equal(snapshot.feed.fullSyncAt, at);
        }
        const health = await (await fetch(origin + '/api/weather/healthz')).json();
        assert.equal(health.notamSourceIssues.total, 0);
        assert.equal(health.readiness.problems.some((p: { product: string }) => p.product === 'notams'), false);
      } finally { await app.close(); }
    }
    assert.equal(calls, 0); assert.deepEqual(await readFile(join(state, 'budget.json')), budget);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
