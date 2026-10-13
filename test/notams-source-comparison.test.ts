import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNotamSourceIssue, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import capture from './fixtures/notams-obbi-2026-10-12.json';
import { icaoEvidence } from '../src/layers/notams/notice-evidence';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { compareNotamContent } from '../tools/info-server/notams/revision';
import { recordWithRevision, createNotamXmlParser } from '../tools/info-server/notams/normalize';
import { NotamStore } from '../tools/info-server/notams/store';
import { createNotamService } from '../tools/info-server/notams/service';
import { bulkXml } from './fixtures/notams';

const issues = capture.issues.map((raw): NotamSourceIssue => {
  const issue: unknown = raw; assert.ok(isNotamSourceIssue(issue)); return issue;
});
const disclaimer = 'UNITED STATES NOTAM OFFICE DISCLAIMS FOREIGN NOTAM ACCURACY OR COMPLETENESS';
const abbreviated = 'UNITED STATES NOF DISCLAIMS FOREIGN NOTAM ACCURACY OR COMPLETENESS';
const changed = (record: NotamRecord, fields: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = { ...record, ...fields }; return recordWithRevision(facts);
};
const transform = (record: NotamRecord, fn: (text: string) => string) => changed(record, {
  text: fn(record.text), translations: record.translations.map(t => ({ ...t, text: fn(t.text) })),
});
const clean = issues[0]!.variants.find(r => !r.text.includes('DISCLAIMS'))!;
const annotate = (record: NotamRecord, text = disclaimer) => transform(record, source => `${source}\r\n${text}`);
const now = Date.parse(capture.capturedAt);

test('captured foreign distribution renderings reconcile in either order and retain all evidence across replay', () => {
  for (const issue of issues) for (const variants of [issue.variants, [...issue.variants].reverse()]) {
    const [a, b] = variants as [NotamRecord, NotamRecord];
    const decision = compareNotamContent(a, b);
    assert.equal(decision.outcome, 'equivalent');
    assert.equal(decision.text.proof, 'icao-distribution-annotation');
    const result = collectNotamRecords({ records: [] }, variants);
    assert.equal(result.issues?.length ?? 0, 0); assert.equal(result.records.length, 1);
    const record = result.records[0]!;
    assert.ok(variants.some(v => v.text === record.text));
    assert.equal(record.text.includes('DISCLAIMS'), false);
    assert.deepEqual(new Set(record.translations.map(t => t.text)), new Set(variants.flatMap(v => v.translations.map(t => t.text))));
    assert.equal(record.year, '2027');
    assert.ok(record.translations.every(t => t.text.startsWith(`A${record.number}/26`)));
    assert.equal(record.updatedAt, a.updatedAt);
    assert.equal(collectNotamRecords(result, [...variants, changed(record, { translations: [] })]), result);
    assert.equal(rebaseNotamRecords(result, [a], now).issues?.length ?? 0, 0);
  }
});

test('distribution annotations compose with field spacing, entities, altitude limits and optional translation presence', () => {
  const bodies = ["RWY 09 CLSD DUE TO WIP", "CRANE 1500' MSL F) SFC G) 2000FT MSL"];
  for (const body of bodies) for (const suffix of [disclaimer, abbreviated]) for (const compact of [false, true]) {
    const original = transform(clean, text => text.replace(clean.text, body));
    const annotated = annotate(original, suffix);
    // The annotation can be present in either representation independently.
    for (const bodyAnnotation of [false, true]) for (const translationAnnotation of [false, true]) {
      const variant = transform(changed(original, {
        text: bodyAnnotation ? annotated.text : original.text,
        translations: (translationAnnotation ? annotated : original).translations.map(t => ({ ...t,
          text: `<pre>\n${compact ? t.text.replace(/([A-GQ]\))\s*/g, '$1') : t.text}\n</pre>` })),
      }), text => text.replaceAll("'", '&apos;').replaceAll(' ', '\n  '));
      for (const order of [[original, variant], [variant, original]]) {
        const result = collectNotamRecords({ records: [] }, order);
        assert.equal(result.issues?.length ?? 0, 0, JSON.stringify({ body, suffix, compact, bodyAnnotation, translationAnnotation }));
        assert.equal(result.records.length, 1);
        if (bodyAnnotation || translationAnnotation) assert.ok([result.records[0]!.text,
          ...result.records[0]!.translations.map(t => t.text)].some(text => text.includes('DISCLAIMS')),
        'a disclaimer supplied only in primary text must remain available after merging');
        assert.equal(collectNotamRecords(result, order), result);
      }
    }
  }
});

test('every operational field and every retained rendering constrains distribution equivalence', () => {
  const annotated = annotate(clean);
  const replaceTranslation = (from: string, to: string) => changed(annotated, {
    translations: annotated.translations.map(t => ({ ...t, text: t.text.replace(from, to) })),
  });
  const mutations: Record<string, NotamRecord> = {
    number: replaceTranslation('A0309/26', 'A0310/26'),
    year: replaceTranslation('/26 NOTAM', '/27 NOTAM'),
    type: replaceTranslation('NOTAMN', 'NOTAMR A0308/26'),
    fir: replaceTranslation('OBBB/', 'OMAE/'),
    selection: replaceTranslation('/QMRLC/', '/QMXLC/'),
    traffic: replaceTranslation('/IV/', '/I/'),
    purpose: replaceTranslation('/NBO/', '/M/'),
    scope: replaceTranslation('/A/', '/E/'),
    lower: replaceTranslation('/000/', '/010/'),
    upper: replaceTranslation('/999/', '/100/'),
    coordinates: replaceTranslation('2616N', '2617N'),
    radius: replaceTranslation('05038E005', '05038E006'),
    location: replaceTranslation('A) OBBI', 'A) OMAA'),
    start: replaceTranslation('B) 2704220800', 'B) 2704220810'),
    end: replaceTranslation('C) 2704220930', 'C) 2704220940'),
    schedule: replaceTranslation('D) BTN 0800-0930', 'D) BTN 0810-0930'),
    body: transform(annotated, text => text.replace('12L / 30R', '12R / 30L')),
    qualityWarning: transform(annotated, text => text.replace('RWY 12L', 'NOTAM SUBJECT TO QUERY: DATES IN DOUBT. RWY 12L')),
    limit: transform(annotated, text => text.replace(disclaimer, `F) SFC G) 2000FT MSL ${disclaimer}`)),
    missingEnvelope: changed(annotated, { translations: [] }),
    additionalRendering: changed(annotated, { translations: [...annotated.translations,
      { type: 'OTHER:ICAO', text: annotated.translations[0]!.text.replace('QMRLC', 'QMXLC') }] }),
    unknownRendering: changed(annotated, { translations: [...annotated.translations, { type: 'OTHER:ICAO', text: 'UNKNOWN' }] }),
    missingEnd: replaceTranslation('C) 2704220930', ''),
    structuredYear: changed(annotated, { year: '2026' }),
  };
  const merged = collectNotamRecords({ records: [] }, [clean, annotated]);
  for (const [name, variant] of Object.entries(mutations)) {
    for (const order of [[clean, variant], [variant, clean]]) {
      assert.equal(collectNotamRecords({ records: [] }, order).issues?.length, 1, name);
    }
    assert.equal(collectNotamRecords(merged, [variant]).issues?.length, 1, `${name}: merged evidence replay`);
  }
});

test('only a complete terminal distribution statement qualifies; unsupported prose stays significant', () => {
  for (const footer of [disclaimer + ' EXCEPT MIL', disclaimer.replace('ACCURACY', 'VALIDITY'),
    disclaimer.toLowerCase(), disclaimer + ' ' + disclaimer, 'NOTAM SUBJECT TO QUERY',
    'ALL OTHER DATA REMAINS AS PUBLISHED.', disclaimer.replace('COMPLETENESS', 'COMPLETE')]) {
    assert.equal(collectNotamRecords({ records: [] }, [clean, annotate(clean, footer)]).issues?.length, 1, footer);
  }
  const embedded = transform(clean, text => text.replace('CLOSED', `CLOSED ${disclaimer}`));
  assert.equal(collectNotamRecords({ records: [] }, [clean, embedded]).issues?.length, 1);
  for (const classification of ['DOMESTIC', 'FDC', 'MILITARY', 'UNKNOWN']) {
    assert.equal(collectNotamRecords({ records: [] }, [changed(clean, { classification }),
      changed(annotate(clean), { classification })]).issues?.length, 1, classification);
  }
  const nested = transform(clean, text => text.replace('WALKING', "PILOT&apos;S"));
  assert.equal(collectNotamRecords({ records: [] }, [nested,
    transform(annotate(nested), text => text.replaceAll('&apos;', '&amp;apos;'))]).issues?.length, 1);
});

test('envelope equality cannot authorize selection-code correction when record binding fails', () => {
  const closure = transform(clean, text => text.replace(clean.text, 'RWY 09 CLSD DUE TO WIP'));
  assert.equal(icaoEvidence(closure)?.recordBound, false, 'captured structured year and ICAO header disagree');
  const alternate = changed(annotate(closure), { translations: annotate(closure).translations.map(t => ({ ...t, text: t.text.replace('QMRLC', 'QMXLC') })) });
  assert.equal(collectNotamRecords({ records: [] }, [closure, alternate]).issues?.length, 1);
  const bound = [closure, alternate].map(r => changed(r, { year: '2026' }));
  assert.equal(compareNotamContent(bound[0]!, bound[1]!).text.proof, 'icao-selection-code');
  assert.equal(collectNotamRecords({ records: [] }, bound).issues?.length ?? 0, 0);
  const reformatted = transform(closure, text => text.replaceAll(' ', '\r\n'));
  assert.equal(compareNotamContent(closure, reformatted).text.proof, 'icao-rendering');
});

test('NMS AIXM decoding and chunked collection preserve distribution evidence', () => {
  const records: NotamRecord[] = [], input = bulkXml(issues.flatMap(i => i.variants), now);
  const parser = createNotamXmlParser(record => records.push(record));
  for (let i = 0; i < input.length; i += 37) parser.write(input.slice(i, i + 37));
  assert.equal(parser.finish().count, 4);
  const collected = collectNotamRecords({ records: [] }, records);
  assert.equal(collected.records.length, 2); assert.equal(collected.issues?.length ?? 0, 0);
  for (const record of collected.records) {
    assert.ok(record.translations.some(t => t.text.includes('DISCLAIMS')));
    assert.ok(record.translations.some(t => !t.text.includes('DISCLAIMS')));
  }
});

test('authenticated recovery repairs distribution issues without hiding contradictions, fetching or changing quota and clocks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-distribution-')), state = join(directory, 'production');
  const contradictory = changed(annotate(clean), { id: '1791813626839001', sourceId: 'NMS_ID_1791813626839001' });
  const bad = collectNotamRecords({ records: [] }, [contradictory, transform(contradictory, text => text.replace('12L', '12R'))]).issues![0]!;
  const store = new NotamStore(state, 'production', () => now);
  try {
    await store.restore(); await store.admission.reserve('bulk');
    await store.publish({ schemaVersion: 2, environment: 'production', checkedAt: now, watermark: now,
      fullSyncAt: now, baselineAt: now, complete: true, records: [], issues: [...issues, bad] });
    const budget = await readFile(join(state, 'budget.json'), 'utf8'); await store.close();
    for (let restart = 0; restart < 2; restart++) {
      const service = createNotamService({ enabled: true, environment: 'production', directory,
        credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
        now: () => now, signal: new AbortController().signal, fetch: async () => assert.fail('Recovery must not acquire source data'),
      });
      try {
        await service.restore();
        const airport = service.readAirport({ icaoId: 'OBBI' })!;
        assert.equal(airport.records.length, 2); assert.deepEqual(airport.issues, [bad]);
        assert.equal(service.status.blockingRecords, 1); assert.equal(service.status.collectionContinuity, 'complete');
        for (const clock of ['checkedAt', 'watermark', 'fullSyncAt'] as const) assert.equal(service.status[clock], now);
        assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
      } finally { await service.close(); }
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
