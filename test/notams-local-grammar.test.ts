import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NotamRecord, NotamSourceIssue } from '@zlayer/contracts';
import { noticeRepresentation, parseLocalNotice } from '../src/layers/notams/representation';
import { fdcBodyForms } from '../src/layers/notams/source-text';
import { subjects } from '../src/layers/notams/subjects';
import { notamEndKind } from '../src/layers/notams/validity';
import { parseNotam } from '../src/layers/notams/parser';
import { notamFlairs } from '../src/layers/notams/flairs';
import { notice } from './fixtures/notams';
import { faaKeywords, fdcHeaderCases, localGrammarNotice } from './fixtures/notams-local-grammar';
import { permutations, batchPartitions } from './helpers/permutations';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { collectNotamRecords } from '../tools/info-server/notams/collection';
import { NotamStore } from '../tools/info-server/notams/store';
import { createNotamService } from '../tools/info-server/notams/service';

const changed = (record: NotamRecord, fields: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = record; return recordWithRevision({ ...facts, ...fields });
};

test('FAA keyword and local header states preserve every body byte across interval spellings', () => {
  assert.deepEqual(Object.keys(subjects).sort(), [...faaKeywords].sort());
  for (const header of fdcHeaderCases) for (const end of ['2610051200', '2610051200EST', 'PERM']) {
    const { record, body, interval, withoutSubject } = localGrammarNotice(header, end);
    for (const left of ['', ' ']) for (const right of ['', ' ']) for (const escaped of [false, true]) {
      let raw = record.translations[0]!.text.replace(interval, interval.replace('-', `${left}-${right}`));
      if (escaped) raw = `<pre>\n${raw.replaceAll('.', '&#46;').replaceAll(' ', '\n  ')}\n</pre>`;
      const view = noticeRepresentation(raw, true)!, parsed = parseLocalNotice(raw);
      assert.ok(parsed.ok, raw);
      assert.equal(parsed.value.subject, header.subject); assert.equal(parsed.value.preamble, header.preamble);
      assert.equal(parsed.value.body, body); assert.equal(parsed.value.end, end);
      assert.deepEqual(parsed.value.representation, view, 'state transitions never rewrite lexical evidence');
      const segment = parsed.value.segments[0]!;
      assert.equal(noticeRepresentation(raw.slice(segment.start, segment.end))!.text, body);
      const forms = fdcBodyForms(record, raw)!;
      assert.ok(forms.has(record.text)); assert.ok(forms.has(withoutSubject));
      assert.ok(forms.has(`${record.text} ${interval.replace('-', `${left}-${right}`)}`));
    }
  }
});

test('every keyword uses the same native proof with unverified qualifiers and attached punctuation', () => {
  for (const subject of faaKeywords) for (const preamble of ['', '(U) ']) for (const separator of [' ', '']) {
    const { record: full, withoutSubject } = localGrammarNotice({ subject, preamble, separator });
    const brief = changed(full, { year: '', text: withoutSubject });
    for (const order of permutations([full, brief])) for (const batches of batchPartitions(order)) {
      let result: ReturnType<typeof collectNotamRecords> = { records: [] };
      for (const batch of batches) result = collectNotamRecords(result, batch);
      assert.equal(result.issues?.length ?? 0, 0, JSON.stringify({ subject, preamble, separator }));
      assert.equal(result.records.length, 1); assert.equal(result.records[0]!.year, full.year);
      assert.deepEqual(result.records[0]!.translations, full.translations);
      assert.ok([full.text, brief.text].includes(result.records[0]!.text));
    }
    for (const unknown of [`${subject}X`, `${subject}_TEST`, `${subject}1`]) {
      assert.equal(parseLocalNotice(full.translations[0]!.text.replace(subject, unknown)).ok, false);
    }
    if (preamble) {
      const omitted = changed(brief, { text: withoutSubject.slice(preamble.length) });
      assert.equal(collectNotamRecords({ records: [] }, [full, omitted]).issues?.length, 1);
    }
  }
});

test('all keywords survive collection and the existing plain-header reader without requiring operational interpretation', () => {
  for (const subject of faaKeywords) {
    const { record: full, body, interval } = localGrammarNotice({ subject, preamble: '', separator: ' ' });
    const brief = changed(full, { text: body });
    const domestic = changed(notice(), { classification: 'DOMESTIC', accountability: 'TST', number: '1',
      text: full.text, translations: [{ type: 'LOCAL_FORMAT', text: `!TST 10/001 TST ${full.text} ${interval}` }] });
    for (const record of [full, brief, changed(full, { text: full.translations[0]!.text }), domestic]) {
      const before = JSON.stringify(record), parsed = parseNotam(record);
      assert.equal(parsed.subject, subject);
      assert.equal(parsed.issues.includes('subject'), false);
      assert.ok(parsed.body.includes(record.text));
      const fact = parsed.facts.find(f => f.kind === 'subject')!;
      assert.ok(fact); assert.equal(fact.evidence.text, subject);
      assert.equal(parsed.body.slice(fact.evidence.start, fact.evidence.end), subject);
      // A more specific runway/taxiway/effect flair can replace the subject
      // label; the parsed subject and its evidence still remain available.
      assert.ok(notamFlairs(parsed).length > 0, subject);
      assert.equal(JSON.stringify(record), before);
    }
    const collected = collectNotamRecords({ records: [] }, [full, changed(brief, { year: '' })]);
    assert.equal(parseNotam(collected.records[0]!).subject, subject);
    // Domestic primary text retains its keyword; the FDC omission policy must
    // not spread merely because both formats use the same vocabulary.
    assert.equal(collectNotamRecords({ records: [] }, [domestic, changed(domestic, { text: body })]).issues?.length, 1);
  }
});

test('every pair of different keywords remains a conflict even when both primary bodies omit the keyword', () => {
  for (let i = 0; i < faaKeywords.length; i++) for (let j = i + 1; j < faaKeywords.length; j++) {
    const left = localGrammarNotice({ subject: faaKeywords[i]!, preamble: '', separator: ' ' });
    const right = localGrammarNotice({ subject: faaKeywords[j]!, preamble: '', separator: ' ' });
    const brief = changed(left.record, { text: left.withoutSubject, year: '' });
    const contrary = changed(right.record, { text: right.withoutSubject });
    assert.equal(brief.text, contrary.text, 'only the retained native keyword distinguishes these bodies');
    for (const order of permutations([left.record, brief, contrary])) for (const batches of batchPartitions(order)) {
      let result: ReturnType<typeof collectNotamRecords> = { records: [] };
      for (const batch of batches) result = collectNotamRecords(result, batch);
      assert.equal(result.records.length, 0, `${faaKeywords[i]} / ${faaKeywords[j]}`);
      assert.equal(result.issues?.length, 1);
      assert.equal(collectNotamRecords(result, [brief, left.record]).issues?.length, 1);
    }
  }
});

test('local grammar preserves qualifiers and refuses unknown headers, incomplete intervals and local multipart', () => {
  const base = localGrammarNotice({ subject: 'IAP', preamble: '', separator: ' ' }).record.translations[0]!.text;
  const qualified = base.replace('IAP TEST', 'IAP U. S. DOD TEST');
  const parsed = parseLocalNotice(qualified); assert.ok(parsed.ok); assert.ok(parsed.value.body.startsWith('U. S. DOD '));
  for (const separator of [' ', '/', ',']) {
    const preamble = Array(32).fill('CA').join(separator);
    assert.ok(parseLocalNotice(base.replace(' IAP ', ` ${preamble} AIRSPACE `)).ok);
    assert.equal(parseLocalNotice(base.replace(' IAP ', ` ${preamble}${separator}CA AIRSPACE `)).ok, false);
    assert.equal(parseLocalNotice(base.replace(' IAP ', ` CA ${preamble} AIRSPACE `)).ok, false);
  }
  for (const bad of [
    base.replace(' IAP ', ' IAPX '), base.replace(' IAP ', ' CHARTED '), base.replace(' IAP ', ' IAP_TEST '),
    base.replace(' IAP ', ' ...SPECIAL NOTICE... '), base.replace(' IAP ', ' CA IAP '),
    base.replace(' IAP ', ' (U) (U) IAP '), base.replace(' IAP ', ' (U) CA ROUTE '), base.replace(' IAP ', ' MN.ROUTE '),
    base.replace(' IAP ', ' MINNESOTA ROUTE '), base.replace(' IAP ', ' CA/ AIRSPACE '),
    base.replace(' IAP ', ' ROUTEX...'), base.replace(' IAP ', 'ROUTE '),
    base.replace('2610041159-2610051200', ''), base.replace('-2610051200', '-UNKNOWN'),
    base.replace('-2610051200', '-261005120'), base.replace('-2610051200', '--2610051200'),
    base + ' EXTRA', base.replace(' IAP ', ' PART 1 OF 2 IAP '),
    base.replace('TEST', 'PART 1 OF 2 TEST'), base.replace(' IAP ', ' SECURITY...PART 1 OF 2 '),
    base.replace('2610041159-2610051200', '2610041159-2610051200 END PART 1 OF 2'),
    `${base} END PART 1 OF 2 ${base} END PART 2 OF 2`,
    base.replace(' IAP ', ` ${'CA '.repeat(33)}AIRSPACE `),
  ]) assert.equal(parseLocalNotice(bad).ok, false, bad);
});

test('EST interval evidence uses the same whitespace grammar and retains every conflicting end', () => {
  const { record, interval } = localGrammarNotice(undefined, '2610051200EST');
  for (const left of ['', ' ', '\n']) for (const right of ['', ' ', '\n']) {
    const text = interval.replace('-', `${left}-${right}`);
    const evidence = { ...record, endKind: 'fixed' as const, text: '', translations: [{ type: 'LOCAL_FORMAT', text }] };
    assert.equal(notamEndKind(evidence), 'estimated');
    assert.equal(notamEndKind({ ...evidence, text: text.replace('2610051200', '2610051201') }), 'unknown');
    assert.equal(notamEndKind({ ...evidence, translations: [{ type: 'LOCAL_FORMAT', text: text.replace('-', '--') }] }), 'fixed');
  }
});

test('state text, punctuation, qualifiers and contrary third variants remain constraints in every batch', () => {
  for (const header of fdcHeaderCases.slice(faaKeywords.length)) {
    const { record: full, withoutSubject } = localGrammarNotice(header);
    const brief = changed(full, { text: withoutSubject, year: '' });
    const mutate = (fn: (text: string) => string) => changed(full, { text: fn(full.text),
      translations: full.translations.map(t => ({ ...t, text: fn(t.text) })) });
    const contrary = [mutate(text => text.replace('TEST CONTENT', 'DIFFERENT CONTENT')),
      mutate(text => text.replace('SIGNIFICANT.', 'SIGNIFICANT...')),
      changed(brief, { text: withoutSubject + ' EXC EMERGENCY' }),
      changed(full, { translations: [...full.translations, { type: 'LOCAL_FORMAT', text: full.translations[0]!.text.replace('TEST CONTENT', 'DIFFERENT CONTENT') }] }),
    ];
    if (header.preamble) contrary.push(mutate(text => text.replace(header.preamble, '')),
      mutate(text => text.replace(header.preamble, 'TX ')), changed(brief, { text: withoutSubject.slice(header.preamble.length) }));
    if (!header.separator) contrary.push(mutate(text => text.replace('...TEST', 'TEST')),
      mutate(text => text.replace('...TEST', '..TEST')));
    for (const bad of contrary) for (const order of permutations([full, brief, bad])) for (const batches of batchPartitions(order)) {
      let result: ReturnType<typeof collectNotamRecords> = { records: [] };
      for (const batch of batches) result = collectNotamRecords(result, batch);
      assert.equal(result.issues?.length, 1, JSON.stringify({ header, bad: bad.text }));
      assert.equal(result.records.length, 0);
      assert.equal(collectNotamRecords(result, [brief, full]).issues?.length, 1);
    }
  }
});

test('authenticated restore repairs all specified local header families without changing source clocks or quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-local-grammar-')), state = join(directory, 'production');
  const now = Date.parse('2026-10-04T12:00:00Z'), store = new NotamStore(state, 'production', () => now);
  const issues: NotamSourceIssue[] = fdcHeaderCases.map((header, index) => {
    const { record, withoutSubject } = localGrammarNotice(header);
    const full = changed(record, { id: `175760000000${String(index).padStart(4, '0')}`, sourceId: `NMS_ID_175760000000${String(index).padStart(4, '0')}` });
    const brief = changed(full, { text: withoutSubject, year: '' });
    const seed = collectNotamRecords({ records: [] }, [full, changed(brief, { text: withoutSubject + ' CONTRARY' })]).issues![0]!;
    return { ...seed, variants: [full, brief] };
  });
  const clocks = { checkedAt: now, watermark: now, fullSyncAt: now - 600_000, baselineAt: now - 660_000 };
  try {
    await store.restore(); await store.admission.reserve('bulk');
    await store.publish({ schemaVersion: 2, environment: 'production', ...clocks, complete: true, records: [], issues });
    const budget = await readFile(join(state, 'budget.json'), 'utf8'); await store.close();
    for (let restart = 0; restart < 2; restart++) {
      const service = createNotamService({ enabled: true, environment: 'production', directory,
        credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
        now: () => now, signal: new AbortController().signal, fetch: async () => assert.fail('Restore must not fetch'),
      });
      try {
        await service.restore();
        assert.equal(service.status.state, 'ready'); assert.equal(service.status.blockingRecords, 0);
        const snapshot = service.readAirport({ faaId: 'ZAB', icaoId: 'KZAB' })!;
        assert.equal(snapshot.records.length, issues.length); assert.deepEqual(snapshot.issues, []);
        for (const issue of issues) {
          const restored = snapshot.records.find(r => r.id === issue.id)!;
          assert.deepEqual(restored.sourceYears, ['', '2026']);
          assert.deepEqual(restored.translations, issue.variants[0]!.translations);
          assert.equal(restored.sourceUpdatedAt, issue.variants[0]!.sourceUpdatedAt);
        }
        const manifest = JSON.parse(await readFile(join(state, 'current.json'), 'utf8'));
        for (const key of ['checkedAt', 'watermark', 'fullSyncAt', 'baselineAt'] as const) assert.equal(manifest[key], clocks[key]);
        assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
      } finally { await service.close(); }
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
