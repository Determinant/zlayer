import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNotamSourceIssue, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import capture from './fixtures/notams-representations-2026-10-09.json';
import rktiCapture from './fixtures/notams-rkti-2026-10-11.json';
import chartCapture from './fixtures/notams-fdc-chart-2026-10-28.json';
import { icaoContentKey, noticeRepresentation, parseFdcIcaoFields, parseIcaoNotice, parseLocalNotice } from '../src/layers/notams/representation';
import { qualifiedFdcLocalText } from '../src/layers/notams/source-text';
import { parseNotam } from '../src/layers/notams/parser';
import { collectNotamRecords, rebaseNotamRecords } from '../tools/info-server/notams/collection';
import { compareNotamContent, compareNotamRevision } from '../tools/info-server/notams/revision';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { NotamStore } from '../tools/info-server/notams/store';
import { createNotamService } from '../tools/info-server/notams/service';
import { createInfoServer } from '../tools/info-server/server';
import { permutations, batchPartitions } from './helpers/permutations';

const capturedIssues = capture.issues.map((raw): NotamSourceIssue => {
  const issue: unknown = raw; assert.ok(isNotamSourceIssue(issue)); return issue;
});
const military = capturedIssues.filter(issue => issue.locations[0] !== 'N81');
const hammonton = capturedIssues.find(issue => issue.locations[0] === 'N81')!;
const chartIssue: NotamSourceIssue = (() => {
  const value: unknown = chartCapture.issues[0]; assert.ok(isNotamSourceIssue(value)); return value;
})();
const changed = (record: NotamRecord, fields: Partial<NotamRecord>) => {
  const { revision: _revision, ...facts } = { ...record, ...fields }; return recordWithRevision(facts);
};
const source = military[0]!.variants.find(v => v.text.includes("1500'"))!;
const transform = (record: NotamRecord, replace: (text: string) => string) => changed(record, {
  text: replace(record.text), translations: record.translations.map(t => ({ ...t, text: replace(t.text) })),
});

test('representation decoding is bounded, single-layer and retains exact source spans', () => {
  const raw = ' \n<pre>1500&apos;  &amp;apos; &#39; &#x27; &unknown; &#10; </pre>\n';
  const view = noticeRepresentation(raw, true)!;
  assert.equal(view.text, "1500' &apos; ' ' &unknown; &#10;");
  assert.deepEqual(view.tokens.map(t => raw.slice(t.start, t.end)), ['1500&apos;', '&amp;apos;', '&#39;', '&#x27;', '&unknown;', '&#10;']);
  assert.ok(view.changes.includes('entities')); assert.ok(view.changes.includes('pre-wrapper'));
  assert.equal(noticeRepresentation('<b>literal</b>', true)!.text, '<b>literal</b>');
  assert.equal(noticeRepresentation('x'.repeat(256 * 1024 + 1)), undefined);
  assert.equal(noticeRepresentation('a '.repeat(32769)), undefined);
  assert.equal(noticeRepresentation('&lt;pre&gt;&amp;apos;&lt;/pre&gt;', true)!.text, '<pre>&apos;</pre>');
});

test('ICAO field states retain multiple locations, body and altitude limits without accepting reordered or missing fields', () => {
  const raw = source.translations[0]!.text + ' F) SFC G) 1500FT MSL';
  const parsed = parseIcaoNotice(raw); assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.locations, ['KOZR', 'KFHK', 'KHEY', 'KLOR', 'KSXS']);
  assert.equal(parsed.value.lower, 'SFC'); assert.equal(parsed.value.upper, '1500FT MSL');
  assert.equal(parsed.value.body, source.text);
  const segment = parsed.value.segments[0]!;
  assert.equal(raw.slice(segment.start, segment.end), source.text);
  for (const bad of [raw.replace('B) 2610091320 C)', 'C) 2610091320 B)'), raw.replace('E)', 'D)'),
    raw.replace(' G) 1500FT MSL', ' F) 1500FT MSL'), raw.replace('A) KOZR', 'A) KOZR KOZR'),
    raw.replace('C) 2610162200', 'C) UNKNOWN'), raw + ' Q) another-notice']) assert.equal(parseIcaoNotice(bad).ok, false, bad);
  const withLimits = changed(source, { text: source.text + ' F) SFC G) 1500FT MSL', translations: [{ type: 'OTHER:ICAO', text: raw }] });
  const encoded = transform(withLimits, text => text.replaceAll("'", '&apos;'));
  assert.equal(collectNotamRecords({ records: [] }, [withLimits, encoded]).issues?.length ?? 0, 0);
  assert.equal(collectNotamRecords({ records: [] }, [withLimits, transform(encoded, text => text.replace('1500FT', '1600FT'))]).issues?.length, 1);
});

test('ICAO field states accept independent compact markers with lossless body spans and lexical evidence', () => {
  const raw = 'M0001/26 NOTAMN Q) KZNY/QXXXX/IV/NBO/A/000/999/4000N07500W005 A) KAAA KBBB ' +
    'B) 2610110000 C) 2610120000 D) DAILY 0800-0900 E) CRANE 1500&apos; MSL F) SFC G) 2000FT MSL';
  const baseline = parseIcaoNotice(raw); assert.ok(baseline.ok);
  const markers = ['Q)', 'A)', 'B)', 'C)', 'D)', 'E)', 'F)', 'G)'];
  // Independent choices include mixed forms, not only all-spaced/all-compact.
  for (let mask = 0; mask < 1 << markers.length; mask++) {
    let variant = raw;
    markers.forEach((marker, bit) => { if (mask & 1 << bit) variant = variant.replace(`${marker} `, marker); });
    const lexical = noticeRepresentation(variant, true)!, parsed = parseIcaoNotice(variant); assert.ok(parsed.ok, variant);
    assert.equal(icaoContentKey(parsed.value), icaoContentKey(baseline.value));
    assert.deepEqual(parsed.value.representation, lexical, 'field consumption never mutates lexical evidence');
    const segment = parsed.value.segments[0]!;
    assert.equal(variant.slice(segment.start, segment.end), 'CRANE 1500&apos; MSL');
    const fdc = parseFdcIcaoFields(variant.slice(variant.indexOf('Q)'))); assert.ok(fdc.ok);
    assert.equal(fdc.value.body, parsed.value.body); assert.equal(fdc.value.schedule, parsed.value.schedule);
    assert.equal(fdc.value.lower, 'SFC'); assert.equal(fdc.value.upper, '2000FT MSL');
  }
  for (const marker of ['E)', 'E&#41;', '&#69;)', '&#x45;&#x29;']) {
    const variant = `<pre>\n${raw.replace('E) ', marker)}\n</pre>`, parsed = parseIcaoNotice(variant); assert.ok(parsed.ok);
    assert.equal(icaoContentKey(parsed.value), icaoContentKey(baseline.value));
    const segment = parsed.value.segments[0]!;
    assert.equal(variant.slice(segment.start, segment.end), 'CRANE 1500&apos; MSL');
  }
});

const altitudeRecord = (lowerSpace = '', upperSpace = '') => transform(source,
  text => `${text} F)${lowerSpace}SFC G)${upperSpace}2000FT MSL`);

test('compact altitude bodies reconcile with independent translation spacing, encoding and complete repetitions', () => {
  const baseline = altitudeRecord(' ', ' ');
  for (const bodyMask of [0, 1, 2, 3]) for (const translationMask of [0, 1, 2, 3]) {
    const body = altitudeRecord(bodyMask & 1 ? ' ' : '', bodyMask & 2 ? ' ' : '');
    const rendering = altitudeRecord(translationMask & 1 ? ' ' : '', translationMask & 2 ? ' ' : '');
    for (const entity of ['&apos;', '&#39;', '&#x27;']) {
      const variant = transform(changed(body, { translations: rendering.translations }),
        text => text.replaceAll("'", entity).replaceAll(' ', '\n  '));
      for (const order of [[baseline, variant], [variant, baseline]]) {
        const decision = compareNotamContent(order[0]!, order[1]!);
        assert.equal(decision.outcome, 'equivalent'); assert.equal(decision.text.proof, 'icao-notice');
        const collected = collectNotamRecords({ records: [] }, order);
        assert.equal(collected.issues?.length ?? 0, 0); assert.equal(collected.records.length, 1);
        assert.ok(order.some(record => record.text === collected.records[0]!.text));
        assert.deepEqual(new Set(collected.records[0]!.translations.map(t => t.text)),
          new Set(order.flatMap(record => record.translations.map(t => t.text))));
        const sparse = changed(collected.records[0]!, { translations: [] });
        assert.equal(collectNotamRecords(collected, [...order, sparse]), collected);
        assert.equal(rebaseNotamRecords(collected, order, source.updatedAt + 1).issues?.length ?? 0, 0);
      }
    }
  }
  const compact = altitudeRecord();
  for (const copies of [1, 2, 32, 33]) {
    const repeated = changed(compact, { text: Array.from({ length: copies }, (_, i) =>
      i % 2 ? baseline.text : compact.text).join(' ') });
    assert.equal(compareNotamContent(baseline, repeated).outcome, copies <= 32 ? 'equivalent' : 'unproven');
  }
  // Lower-only and upper-only fields have the same qualified spacing policy.
  for (const remove of [/ F\) ?SFC/g, / G\) ?2000FT MSL/g]) {
    assert.equal(compareNotamContent(transform(baseline, text => text.replace(remove, '')),
      transform(compact, text => text.replace(remove, '').replaceAll("'", '&apos;'))).outcome, 'equivalent');
  }
});

test('compact altitude evidence cannot hide changed values, partial repetitions or unqualified body rewrites', () => {
  const baseline = altitudeRecord(' ', ' '), encoded = transform(altitudeRecord(), text => text.replaceAll("'", '&apos;'));
  for (const variant of [
    transform(encoded, text => text.replace('2000FT', '2100FT')),
    transform(encoded, text => text.replace('F)SFC', 'F)100FT')),
    transform(encoded, text => text.replace('G)2000FT MSL', 'G)2000FT AGL')),
    changed(encoded, { text: encoded.text.replace('2000FT', '2100FT') }),
    changed(encoded, { text: encoded.text.replace(' F)SFC', '') }),
    changed(encoded, { text: encoded.text.replace('F)SFC G)2000FT MSL', 'G)2000FT MSL F)SFC') }),
    changed(encoded, { text: `${encoded.text} ${source.text}` }),
    changed(encoded, { text: `${source.text} ${encoded.text}` }),
    changed(encoded, { text: encoded.text + ' EXTRA' }),
    changed(encoded, { translations: [] }),
    transform(encoded, text => text.replaceAll('&apos;', '&amp;apos;')),
  ]) for (const order of [[baseline, variant], [variant, baseline]]) {
    assert.equal(collectNotamRecords({ records: [] }, order).issues?.length, 1);
  }
  const prose = transform(baseline, text => text.replace('ALL AIRCRAFT', 'ALL AIRCRAFT Q)CODE'));
  assert.equal(collectNotamRecords({ records: [] }, [prose,
    transform(prose, text => text.replace('Q)CODE', 'Q) CODE'))]).issues?.length, 1);
});

test('identical ICAO renderings witness compact body-only text without requiring a missing C) field', () => {
  const compact = altitudeRecord();
  const translations = compact.translations.map(t => ({ ...t, text: t.text.replace(' C) 2610162200', '') }));
  const body = changed(compact, { translations }), full = changed(body, { text: translations[0]!.text });
  for (const order of [[body, full], [full, body]]) {
    assert.equal(compareNotamContent(order[0]!, order[1]!).text.proof, 'icao-body');
    assert.equal(collectNotamRecords({ records: [] }, order).issues?.length ?? 0, 0);
  }
  assert.equal(collectNotamRecords({ records: [] }, [full,
    changed(body, { text: body.text.replace('2000FT', '2100FT') })]).issues?.length, 1);
});

test('compact altitude conflicts recover on authenticated restore and remain resolved after publication and restart', async () => {
  const variants = [altitudeRecord(), transform(altitudeRecord(' ', ' '), text => text.replaceAll("'", '&apos;'))];
  const issue: NotamSourceIssue = { ...military[0]!, variants };
  const directory = await mkdtemp(join(tmpdir(), 'notam-altitude-')), state = join(directory, 'production');
  const now = Date.parse(capture.capturedAt), store = new NotamStore(state, 'production', () => now);
  try {
    await store.restore(); await store.admission.reserve('bulk');
    await store.publish({ schemaVersion: 2, environment: 'production', checkedAt: now, watermark: now, fullSyncAt: now,
      baselineAt: now, complete: true, records: [], issues: [issue] });
    const budget = await readFile(join(state, 'budget.json'), 'utf8'); await store.close();
    for (let restart = 0; restart < 2; restart++) {
      const restored = new NotamStore(state, 'production', () => now);
      try {
        const snapshot = await restored.restore(); assert.ok(snapshot);
        assert.equal(snapshot.issues?.length ?? 0, 0); assert.equal(snapshot.records.length, 1);
        for (const clock of ['checkedAt', 'watermark', 'fullSyncAt', 'baselineAt'] as const) assert.equal(snapshot[clock], now);
        assert.deepEqual(new Set(snapshot.records[0]!.translations.map(t => t.text)),
          new Set(variants.flatMap(record => record.translations.map(t => t.text))));
        assert.equal(collectNotamRecords(snapshot, variants), snapshot);
        await restored.publish(snapshot);
        assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
      } finally { await restored.close(); }
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('compact field boundaries preserve prose, optional end policy and strict envelope ordering', () => {
  const raw = 'M0001/26 NOTAMN Q)KZNY/QXXXX////// A)KAAA B)2610110000 C)2610120000 E)CHECK Q)CODE A)ITEM ' +
    'RWY E)REFERENCE XQ)TEXT F)SFC G)2000FT MSL';
  const parsed = parseIcaoNotice(raw); assert.ok(parsed.ok);
  assert.equal(parsed.value.body, 'CHECK Q)CODE A)ITEM RWY E)REFERENCE XQ)TEXT');
  assert.equal(parsed.value.lower, 'SFC'); assert.equal(parsed.value.upper, '2000FT MSL');
  assert.equal(parseIcaoNotice(raw.replace(' F)SFC', '')).ok, true);
  const missingEnd = raw.replace(' C)2610120000', '');
  assert.equal(parseIcaoNotice(missingEnd).ok, false);
  assert.equal(parseIcaoNotice(missingEnd, { allowMissingEnd: true }).ok, true);
  assert.equal(parseIcaoNotice(missingEnd.replace('E)CHECK', 'D)DAILY 0800-0900 E)CHECK'), { allowMissingEnd: true }).ok, true);
  for (const bad of [
    raw.replace('A)KAAA', 'A)KAAA KAAA'), raw.replace('B)2610110000 C)2610120000', 'C)2610120000 B)2610110000'),
    raw.replace('C)2610120000', 'C)UNKNOWN'), raw.replace('E)CHECK', 'D)DAILY B)2610110000 E)CHECK'),
    raw.replace('E)CHECK', 'D)E)CHECK'), raw.replace('F)SFC', 'F)G)SFC'), raw + ' F)SFC', raw + ' G)2000FT MSL',
    raw.replace(' F)SFC G)2000FT MSL', ' G)2000FT MSL F)SFC'),
    raw.replace('Q)KZNY', 'Q&amp;#41;KZNY'), raw.replace('Q)KZNY', 'XQ)KZNY'),
  ]) assert.equal(parseIcaoNotice(bad).ok, false, bad);
});

test('compact markers preserve multipart identity, order, closure and source spans', () => {
  const part = (n: number, body: string) => `M0001/26 NOTAMN Q)KZNY/QXXXX////// A)KAAA PART ${n} OF 2 ` +
    `B)2610110000 C)2610120000 E)${body} END PART ${n} OF 2`;
  const raw = `${part(2, 'SECOND BODY')} ${part(1, 'FIRST BODY')}`;
  const parsed = parseIcaoNotice(raw); assert.ok(parsed.ok);
  assert.equal(parsed.value.body, 'FIRST BODY SECOND BODY');
  assert.deepEqual(parsed.value.segments.map(segment => raw.slice(segment.start, segment.end)), ['FIRST BODY', 'SECOND BODY']);
  for (const bad of [part(1, 'FIRST BODY'), raw.replace('END PART 2', 'END PART 1'),
    raw.replace('QXXXX', 'QMRLC'), raw.replace('M0001/26', 'M0002/26'), raw + ' ' + part(1, 'DUPLICATE')]) {
    assert.equal(parseIcaoNotice(bad).ok, false, bad);
  }
});

test('captured RKTI subject-code correction reconciles only through its complete runway-closure evidence', () => {
  const issue: unknown = rktiCapture.issues[0]; assert.ok(isNotamSourceIssue(issue));
  const [a, b] = issue.variants as [NotamRecord, NotamRecord];
  assert.equal(compareNotamRevision(a, b), 0);
  for (const order of [[a, b], [b, a]]) {
    const comparison = compareNotamContent(order[0]!, order[1]!);
    assert.equal(comparison.outcome, 'equivalent'); assert.equal(comparison.text.proof, 'icao-selection-code');
    assert.deepEqual(comparison.fields, []);
    const collected = collectNotamRecords({ records: [] }, order);
    assert.equal(collected.records.length, 1); assert.equal(collected.issues?.length ?? 0, 0);
    assert.deepEqual(new Set(collected.records[0]!.translations.map(t => t.text)), new Set([a, b].flatMap(r => r.translations.map(t => t.text))));
    assert.equal(collectNotamRecords(collected, order), collected);
    assert.equal(rebaseNotamRecords(collected, order.slice(0, 1), issue.variants[0]!.updatedAt + 1).issues?.length ?? 0, 0);
    const equivalent = changed(order[0]!, { translations: order[0]!.translations.map(t => ({ ...t,
      text: t.text.replace(/([A-GQ]\))\s*/g, '$1') })) });
    assert.equal(compareNotamContent(order[0]!, equivalent).outcome, 'equivalent');
    const merged = collectNotamRecords({ records: [] }, [order[0]!, equivalent]);
    assert.equal(merged.issues?.length ?? 0, 0); assert.equal(merged.records.length, 1);
    assert.equal(merged.records[0]!.updatedAt, order[0]!.updatedAt);
  }
});

test('surface subject-code proof handles runway and taxiway closures without relaxing other notice content', () => {
  const captured: unknown = rktiCapture.issues[0]; assert.ok(isNotamSourceIssue(captured));
  const [a, b] = captured.variants as [NotamRecord, NotamRecord];
  for (const body of ['RWY 09 CLSD', 'RWY 09/27 CLSD DUE TO WIP', 'TWY A1 CLSD', 'TWY B CLSD DUE TO WIP']) {
    const pair = [a, b].map(record => transform(record, text => text.replace(a.text, body)));
    for (const order of [pair, [...pair].reverse()]) {
      const collected = collectNotamRecords({ records: [] }, order);
      assert.equal(collected.issues?.length ?? 0, 0, body);
      assert.equal(collected.records[0]!.text, body);
      const replay = changed(collected.records[0]!, { translations: [] });
      assert.equal(collectNotamRecords(collected, [...order, replay]), collected);
    }
  }
  // A recognized prefix or an unrelated matching operational fact is not proof.
  for (const body of ['RWY 00 CLSD', 'RWY 37 CLSD', 'RWY 18L/36R NOT CLSD', 'RWY 18L/36R CLSD EXC MIL',
    'RWY 18L/36R CLSD DUE TO WIP TWY A OPEN', 'RWY 18L/36R MAY BE CLSD', 'TWY A/B CLSD', 'UNKNOWN']) {
    const pair = [a, b].map(record => transform(record, text => text.replace(a.text, body)));
    assert.equal(collectNotamRecords({ records: [] }, pair).issues?.length, 1, body);
  }
  for (const variant of [
    transform(b, text => text.replace('18L/36R', '18R/36L')),
    transform(b, text => text.replace('CLSD DUE TO WIP', 'OPEN')),
    transform(b, text => text.replace('RKRR', 'RJJJ')),
    transform(b, text => text.replace('QMXLC', 'QMXLT')),
    transform(b, text => text.replace('QMXLC', 'QZZLC')),
    transform(b, text => text.replace('QMXLC//////', 'QMXLC/I/BO/A/000/999/3702N12753E005')),
    transform(b, text => text.replace('M0398/26', 'M0399/26')),
    transform(b, text => text.replace('A) RKTI', 'A) RKTA')),
    transform(b, text => text.replace('2610170900', '2610171000')),
    transform(b, text => text.replace(' E)', ' D) DAILY 0800-0900 E)')),
    transform(b, text => text + ' F)SFC G)2000FT MSL'),
    changed(b, { text: b.text + ' EXTRA' }),
    changed(b, { translations: [...b.translations, { type: 'OTHER:ICAO', text: b.translations[0]!.text.replace('QMXLC', 'QZZLC') }] }),
  ]) for (const order of [[a, variant], [variant, a]]) {
    assert.equal(collectNotamRecords({ records: [] }, order).issues?.length, 1);
    const merged = collectNotamRecords({ records: [] }, [a, b]);
    assert.equal(collectNotamRecords(merged, [variant]).issues?.length, 1, 'all retained evidence constrains a later replay');
  }
  // Even equal non-code differences must not be erased by this proof.
  for (const replace of [
    (text: string) => text + ' F)SFC G)2000FT MSL',
    (text: string) => text.replace('NOTAMN', 'NOTAMR M0397/26'),
    (text: string) => text.replace(' C) 2610170900', ''),
  ]) assert.equal(collectNotamRecords({ records: [] }, [transform(a, replace), transform(b, replace)]).issues?.length, 1);
});

test('restored compact and subject-code evidence repairs proven issues while retaining genuine conflicts and source clocks', async () => {
  const captured: unknown = rktiCapture.issues[0]; assert.ok(isNotamSourceIssue(captured));
  const at = rktiCapture.checkedAt;
  for (const kind of ['spacing', 'selection-code', 'conflict']) {
    const conflict = kind === 'conflict';
    const original: NotamRecord = captured.variants[0]!;
    const compact = changed(original, { translations: original.translations.map(t => ({ ...t,
      text: t.text.replace(/([A-GQ]\))\s*/g, '$1') })) });
    const issue: NotamSourceIssue = { ...captured, variants: kind === 'spacing' ? [original, compact]
      : conflict ? [original, transform(captured.variants[1]!, text => text.replace('QMXLC', 'QMXLT'))] : captured.variants };
    const directory = await mkdtemp(join(tmpdir(), 'notam-compact-')), state = join(directory, 'production');
    const store = new NotamStore(state, 'production', () => at);
    let app: Awaited<ReturnType<typeof createInfoServer>> | undefined;
    try {
      await store.restore(); await store.admission.reserve('bulk');
      await store.publish({ schemaVersion: 2, environment: 'production', records: [], issues: [issue],
        complete: true, checkedAt: at, watermark: at, fullSyncAt: at, baselineAt: at });
      const budget = await readFile(join(state, 'budget.json'), 'utf8'); await store.close();
      app = await createInfoServer({ directory: join(directory, 'weather'), startUpdates: false, now: () => at,
        notams: { enabled: true, environment: 'production', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } },
        fetch: async () => assert.fail('Restoration and HTTP reads must not acquire source data') });
      await app.notams.restore();
      await new Promise<void>(resolve => app!.server.listen(0, '127.0.0.1', resolve));
      const address = app.server.address(); assert.ok(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
      const health = await (await fetch(origin + '/api/weather/healthz')).json();
      const airport = await (await fetch(origin + '/api/notams/airports?icaoId=RKTI')).json();
      assert.deepEqual(await (await fetch(origin + '/api/notams/healthz')).json(), health.notams);
      assert.equal(health.notams.blockingRecords, conflict ? 1 : 0);
      assert.equal(health.notams.state, conflict ? 'degraded' : 'ready');
      assert.equal(health.notams.collectionContinuity, 'complete');
      for (const clock of ['checkedAt', 'watermark', 'fullSyncAt']) assert.equal(health.notams[clock], at);
      assert.equal(health.readiness.sources.notams.fresh, true);
      assert.deepEqual(health.readiness.problems.filter((p: { product: string }) => p.product === 'notams'),
        conflict ? [{ product: 'notams', reason: 'unresolved-records', severity: 'error' }] : []);
      assert.equal(airport.contentCoverage, conflict ? 'incomplete' : 'complete');
      if (conflict) {
        assert.equal(airport.records.length, 0); assert.deepEqual(airport.issues, [issue]);
        assert.deepEqual(health.notamSourceIssues.samples[0].comparisons,
          [{ outcome: 'contradictory', fields: ['translations'], proof: 'exact', reason: 'different-content' }]);
      } else {
        assert.equal(airport.records.length, 1); assert.deepEqual(airport.issues, []);
        assert.deepEqual(new Set(airport.records[0].translations.map((t: { text: string }) => t.text)),
          new Set(issue.variants.flatMap(v => v.translations.map(t => t.text))));
        assert.equal(airport.records[0].updatedAt, original.updatedAt);
      }
      assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
    } finally { await app?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('encoding and formatting families reconcile across permutations and sparse replays with raw evidence intact', () => {
  for (const spelling of ['&apos;', '&#39;', '&#x27;']) for (const wrapped of [true, false]) {
    const encoded = transform(source, text => text.replaceAll("'", spelling).replaceAll(' ', '\n  '));
    const variant = changed(encoded, { translations: encoded.translations.map(t => ({ ...t, text: wrapped ? `<pre>\n${t.text}\n</pre>` : t.text })) });
    for (const order of [[source, variant], [variant, source]]) {
      const decision = compareNotamContent(order[0]!, order[1]!);
      assert.equal(decision.outcome, 'equivalent'); assert.equal(decision.text.proof, 'icao-notice');
      const collected = collectNotamRecords({ records: [] }, order);
      assert.equal(collected.issues?.length ?? 0, 0);
      assert.equal(collected.records[0]!.updatedAt, source.updatedAt);
      assert.equal(collected.records[0]!.translations.length, 2);
      for (const text of order.flatMap(r => r.translations.map(t => t.text))) assert.ok(collected.records[0]!.translations.some(t => t.text === text));
      const sparse = changed(collected.records[0]!, { translations: [] });
      assert.equal(collectNotamRecords(collected, [...order, sparse]), collected);
      assert.equal(rebaseNotamRecords(collected, order, source.updatedAt + 1).issues?.length ?? 0, 0);
    }
  }
});

test('decoding needs complete evidence and cannot hide changed body, identity, limits, dates or nested escaping', () => {
  const encoded = transform(source, text => text.replaceAll("'", '&apos;'));
  for (const variant of [
    transform(encoded, text => text.replace('1500', '1600')),
    transform(encoded, text => text.replace('MSL', 'AGL')),
    transform(encoded, text => text.replace('0800-1700', '0800-1800')),
    transform(encoded, text => text.replace('ALL AIRCRAFT', 'EXC EMERG ACFT')),
    transform(encoded, text => text.replaceAll('&apos;', '&amp;apos;')),
    changed(encoded, { translations: [] }),
    changed(encoded, { translations: encoded.translations.map(t => ({ ...t, text: t.text.replace('M1216/26', 'M1217/26') })) }),
    changed(encoded, { translations: encoded.translations.map(t => ({ ...t, text: t.text.replace('2610162200', '2610172200') })) }),
    changed(encoded, { translations: encoded.translations.map(t => ({ ...t, text: t.text.replace(' C) 2610162200', '') })) }),
    changed(encoded, { translations: encoded.translations.map(t => ({ ...t, text: t.text.replace(' E) ', ' E) PART 1 OF 2 ') })) }),
  ]) for (const order of [[source, variant], [variant, source]]) {
    assert.equal(collectNotamRecords({ records: [] }, order).issues?.length, 1);
  }
  const noEvidence = [source, encoded].map(r => changed(r, { translations: [] }));
  assert.equal(compareNotamContent(noEvidence[0]!, noEvidence[1]!).outcome, 'unproven');
  const conflicting = transform(encoded, text => text.replace('1500', '1600'));
  assert.equal(compareNotamContent(source, conflicting).outcome, 'contradictory');
  const sparse = changed(source, { text: encoded.text, translations: [] });
  for (const order of [[source, conflicting, sparse], [sparse, source, conflicting], [conflicting, sparse, source]]) {
    assert.equal(collectNotamRecords({ records: [] }, order).issues?.length, 1);
  }
});

test('comparison outcomes distinguish omitted evidence, unknown renderings and understood contradictions', () => {
  assert.equal(compareNotamContent(source, changed(source, { translations: [] })).outcome, 'compatible-evidence');
  const unknown = (text: string) => changed(source, { translations: [...source.translations, { type: 'OTHER:UNSUPPORTED', text }] });
  const unproven = compareNotamContent(unknown('rendering A'), unknown('rendering B'));
  assert.equal(unproven.outcome, 'unproven'); assert.equal(unproven.text.failure, 'unsupported-representation');
  assert.equal(compareNotamContent(changed(source, { schedule: 'UNRECOGNIZED A' }), changed(source, { schedule: 'UNRECOGNIZED B' })).outcome, 'unproven');
  assert.equal(compareNotamContent(changed(source, { schedule: 'MON 0800-1700' }), changed(source, { schedule: 'TUE 0800-1700' })).outcome, 'contradictory');
});

test('local envelope parsing preserves raw prose while continuation evidence selects a complete rendering', () => {
  for (const record of hammonton.variants) {
    const raw = record.translations[0]!.text, parsed = parseLocalNotice(raw); assert.ok(parsed.ok);
    assert.equal(parsed.value.subject, 'ODP'); assert.equal(parsed.value.location, 'N81');
    assert.equal(parsed.value.end, '2810101505EST');
    assert.equal(qualifiedFdcLocalText(record), raw);
    assert.equal(parseNotam(record).subject, 'ODP');
    const segment = parsed.value.segments[0]!;
    assert.equal(noticeRepresentation(raw.slice(segment.start, segment.end))!.text, parsed.value.body);
  }
  assert.equal(compareNotamContent(...hammonton.variants as [NotamRecord, NotamRecord]).text.proof, 'fdc-continuation');
  const resolved = collectNotamRecords({ records: [] }, hammonton.variants);
  assert.equal(resolved.records.length, 1); assert.equal(resolved.issues?.length ?? 0, 0);
  assert.deepEqual(new Set(resolved.records[0]!.translations.map(t => t.text)), new Set(hammonton.variants.flatMap(r => r.translations.map(t => t.text))));
});

test('FDC CHART uses the local envelope states and preserves body spans and required boundaries', () => {
  const native = chartIssue.variants[0]!.translations.find(t => t.type === 'LOCAL_FORMAT')!.text;
  for (const raw of [native, `<pre>\n${native.replaceAll(' ', '\n  ')}\n</pre>`]) {
    const parsed = parseLocalNotice(raw); assert.ok(parsed.ok);
    assert.equal(parsed.value.office, 'FDC'); assert.equal(parsed.value.number, '6/2892');
    assert.equal(parsed.value.location, 'FDC'); assert.equal(parsed.value.subject, 'CHART');
    assert.equal(parsed.value.start, '2610271838'); assert.equal(parsed.value.end, 'PERM');
    assert.equal(parsed.value.body, chartIssue.variants[1]!.text);
    const segment = parsed.value.segments[0]!;
    assert.equal(noticeRepresentation(raw.slice(segment.start, segment.end))!.text, parsed.value.body);
  }
  for (const raw of [native.replace('FDC CHART', 'FDC CHARTED'), native.replace('FDC CHART', 'FDC'),
    native.replace('6/2892', '2892/6'), native.replace(' 2610271838-PERM', ''),
    native.replace('-PERM', '-UNKNOWN'), native + ' EXTRA', native.replace('CORRECT', 'PART 1 OF 2 CORRECT')]) {
    assert.equal(parseLocalNotice(raw).ok, false, raw);
  }
});

test('captured CHART variants reconcile in every delivery order without losing source evidence', () => {
  const original = JSON.stringify(chartIssue), [a, b] = chartIssue.variants as [NotamRecord, NotamRecord];
  const comparison = compareNotamContent(a, b);
  assert.equal(comparison.outcome, 'compatible-evidence'); assert.equal(comparison.text.proof, 'local-notice');
  assert.deepEqual(comparison.fields, []); assert.deepEqual(comparison.evidence, ['source-year-omission']);
  for (const order of permutations([a, b])) for (const batches of batchPartitions(order)) {
    let collection: ReturnType<typeof collectNotamRecords> = { records: [] };
    for (const batch of batches) collection = collectNotamRecords(collection, batch);
    assert.equal(collection.issues?.length ?? 0, 0); assert.equal(collection.records.length, 1);
    const record = collection.records[0]!;
    assert.equal(record.year, '2026'); assert.deepEqual(record.sourceYears, ['', '2026']);
    assert.equal(record.updatedAt, a.updatedAt); assert.equal(record.sourceUpdatedAt, a.sourceUpdatedAt);
    assert.equal(record.effectiveStart, a.effectiveStart); assert.equal(record.effectiveEnd, 'PERM');
    assert.ok([a.text, b.text].includes(record.text));
    assert.deepEqual(new Set(record.translations.map(t => JSON.stringify(t))),
      new Set([a, b].flatMap(r => r.translations.map(t => JSON.stringify(t)))));
    assert.equal(collectNotamRecords(collection, [...order, changed(record, { translations: [] })]), collection);
    for (const baseline of [[a], [b]]) {
      const rebased = rebaseNotamRecords(collection, baseline, a.updatedAt + 1);
      assert.equal(rebased.issues?.length ?? 0, 0);
      assert.deepEqual(rebased.records[0], record);
    }
  }
  assert.equal(JSON.stringify(chartIssue), original);
});

test('CHART native evidence composes with independent year omissions, body wrappers and lexical forms', () => {
  const [a, b] = chartIssue.variants as [NotamRecord, NotamRecord];
  // Constructed combinations of the existing FDC wrapper grammar, not new captures.
  for (const years of [['2026', ''], ['', '2026'], ['2026', '2026']])
    for (const subject of ['', 'CHART ']) for (const interval of ['', ' 2610271838-PERM'])
      for (const formatted of [false, true]) {
        const previous = changed(a, { year: years[0]! });
        const next = changed(b, { year: years[1]!, text: `${subject}${b.text}${interval}`,
          translations: b.translations.map(t => ({ ...t, text: formatted ? `<pre>\n${t.text.replaceAll(' ', '\n  ')}\n</pre>` : t.text })) });
        for (const order of [[previous, next], [next, previous]]) {
          const result = collectNotamRecords({ records: [] }, order);
          assert.equal(result.issues?.length ?? 0, 0); assert.equal(result.records.length, 1);
          assert.equal(result.records[0]!.year, '2026');
          for (const translation of order.flatMap(r => r.translations))
            assert.ok(result.records[0]!.translations.some(t => t.type === translation.type && t.text === translation.text));
        }
      }
});

test('CHART recognition cannot erase changed content, identity, validity or incomplete native evidence', () => {
  const [a, b] = chartIssue.variants as [NotamRecord, NotamRecord];
  const localChanged = (from: string, to: string) => changed(b, { translations: b.translations.map(t =>
    t.type === 'LOCAL_FORMAT' ? { ...t, text: t.text.replace(from, to) } : t) });
  const variants = [
    transform(b, text => text.replace('700 FEET', '800 FEET')),
    transform(b, text => text.replace('7-MILE', '8-MILE')),
    changed(b, { text: b.text + ' EXC EMERGENCY' }), changed(b, { year: '2025' }),
    changed(b, { locations: ['XYZ'] }), changed(b, { schedule: 'DAILY 0800-0900' }),
    changed(b, { effectiveStart: '202610271839', startsAt: b.startsAt! + 60_000 }),
    localChanged('6/2892', '6/2893'), localChanged('FDC CHART', 'XYZ CHART'),
    localChanged('2610271838-PERM', '2610271839-PERM'), localChanged('FDC CHART', 'FDC UNKNOWN'),
    changed(b, { translations: [...b.translations, { type: 'LOCAL_FORMAT', text: a.translations[0]!.text.replace('700 FEET', '800 FEET') }] }),
  ];
  for (const variant of variants) for (const order of permutations([a, b, variant])) for (const batches of batchPartitions(order)) {
    let collection: ReturnType<typeof collectNotamRecords> = { records: [] };
    for (const batch of batches) collection = collectNotamRecords(collection, batch);
    assert.equal(collection.records.length, 0); assert.equal(collection.issues?.length, 1);
    assert.equal(collectNotamRecords(collection, [changed(b, { translations: [] })]).issues?.length, 1);
  }
  const noNative = [a, b].map(record => changed(record, { translations: record.translations.filter(t => t.type !== 'LOCAL_FORMAT') }));
  assert.equal(collectNotamRecords({ records: [] }, noNative).issues?.length, 1);
  assert.equal(collectNotamRecords({ records: [], issues: [{ ...chartIssue, variantsTruncated: true }] }, [a, b]).issues?.length, 1);
});

test('saved CHART conflicts recover through authenticated restore without changing clocks or FAA quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-chart-')), state = join(directory, 'production');
  const now = chartCapture.checkedAt, store = new NotamStore(state, 'production', () => now);
  const clocks = { checkedAt: now, watermark: now, fullSyncAt: now - 600_000, baselineAt: now - 660_000 };
  try {
    await store.restore(); await store.admission.reserve('bulk');
    await store.publish({ schemaVersion: 2, environment: 'production', ...clocks,
      complete: true, records: [], issues: [chartIssue] });
    const budget = await readFile(join(state, 'budget.json'), 'utf8'); await store.close();
    for (let restart = 0; restart < 2; restart++) {
      const service = createNotamService({ enabled: true, environment: 'production', directory,
        credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
        now: () => now, signal: new AbortController().signal, fetch: async () => assert.fail('Restore must not fetch'),
      });
      try {
        await service.restore();
        assert.equal(service.status.state, 'ready'); assert.equal(service.status.blockingRecords, 0);
        assert.equal(service.status.collectionContinuity, 'complete'); assert.equal(service.sourceIssues!.total, 0);
        for (const clock of ['checkedAt', 'watermark', 'fullSyncAt'] as const) assert.equal(service.status[clock], clocks[clock]);
        const snapshot = service.readAirport({ faaId: 'FDC', icaoId: 'KFDC' })!;
        assert.equal(snapshot.contentCoverage, 'complete'); assert.equal(snapshot.records.length, 1);
        assert.deepEqual(snapshot.issues, []); assert.deepEqual(snapshot.records[0]!.sourceYears, ['', '2026']);
        assert.deepEqual(new Set(snapshot.records[0]!.translations.map(t => JSON.stringify(t))),
          new Set(chartIssue.variants.flatMap(r => r.translations.map(t => JSON.stringify(t)))));
        assert.equal(snapshot.records[0]!.sourceUpdatedAt, chartIssue.variants[0]!.sourceUpdatedAt);
        const manifest = JSON.parse(await readFile(join(state, 'current.json'), 'utf8'));
        for (const clock of ['checkedAt', 'watermark', 'fullSyncAt', 'baselineAt'] as const) assert.equal(manifest[clock], clocks[clock]);
        assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
      } finally { await service.close(); }
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('authenticated restore repairs proven representations and preserves clocks, quota and health qualification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-representation-')), state = join(directory, 'production');
  const now = Date.parse(capture.capturedAt), store = new NotamStore(state, 'production', () => now);
  const service = createNotamService({ enabled: true, environment: 'production', directory, credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
    now: () => now, signal: new AbortController().signal, fetch: async () => assert.fail('Restore must not fetch'),
  });
  try {
    await store.restore(); await store.admission.reserve('bulk');
    await store.publish({ schemaVersion: 2, environment: 'production', checkedAt: now, watermark: now, fullSyncAt: now,
      baselineAt: now, complete: true, records: [], issues: capturedIssues });
    const budget = await readFile(join(state, 'budget.json'), 'utf8'); await store.close();
    await service.restore();
    assert.equal(service.status.blockingRecords, 0); assert.equal(service.status.state, 'ready');
    assert.equal(service.status.checkedAt, now); assert.equal(service.status.watermark, now);
    assert.equal(service.status.fullSyncAt, now); assert.equal(service.status.collectionContinuity, 'complete');
    for (const issue of military) assert.equal(service.readAirport({ faaId: issue.locations[0]! })!.contentCoverage, 'complete');
    assert.equal(service.readAirport({ faaId: 'N81' })!.contentCoverage, 'complete');
    assert.ok(service.sourceIssues);
    assert.equal(service.sourceIssues.total, 0);
    assert.equal(await readFile(join(state, 'budget.json'), 'utf8'), budget);
  } finally { await service.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});
