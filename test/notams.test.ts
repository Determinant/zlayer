import assert from 'node:assert/strict';
import test from 'node:test';
import { isNotamAirportQuery, isNotamAirportSnapshot, notamAirportKey, NOTAM_REFRESH_MS } from '@zlayer/contracts';
import { parseNotam } from '../src/layers/notams/parser';
import { notamEndKind, notamValidity } from '../src/layers/notams/validity';
import { matchPlateNotams, normalizeProcedureTitle } from '../src/layers/notams/matcher';
import { procedureNoticeContext, resolvePlateNoticeContext } from '../src/layers/plates/page-context';
import { procedureSelection } from '../src/layers/plates/data';
import { createNotamsClient } from '../src/layers/notams/client';
import { detailedNotices, notice, notamSnapshot, NOTAM_NOW, testAirport, testCatalog, testProcedure, testResource } from './fixtures/notams';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('NOTAM contract keeps airport namespaces, source strings and complete snapshots', () => {
  assert.ok(isNotamAirportQuery({ faaId: '0Q3' })); assert.ok(isNotamAirportQuery({ faaId: 'ANC', icaoId: 'PANC' }));
  for (const bad of [{}, { id: 'KTST' }, { faaId: 'tst' }, { faaId: 'TST', url: 'x' }]) assert.equal(isNotamAirportQuery(bad), false);
  assert.ok(isNotamAirportSnapshot(notamSnapshot()));
  assert.equal(isNotamAirportSnapshot(notamSnapshot([notice(), notice()])), false);
  assert.notEqual(notamAirportKey({ faaId: 'TST' }), notamAirportKey({ icaoId: 'KTST' }));
});
test('flairs keep the subject, effect, qualifications and evidence separate', () => {
  const lights = parseNotam(notice());
  assert.ok(lights.flairs.some(f => f.label === 'Lighting Unavailable'));
  assert.ok(!lights.flairs.some(f => f.label === 'Runway Closed'));
  const closure = parseNotam(notice({ text: 'RWY 9L/27R CLSD EXC EMERG ACFT' }));
  assert.ok(closure.flairs.some(f => f.label === 'Runway Closed')); assert.match(closure.body, /EXC EMERG/);
  const pointer = parseNotam(notice({ text: 'AD SEE FDC 6/1001 FOR IAP RESTRICTIONS' }));
  assert.equal(pointer.subject, 'AD'); assert.equal(pointer.procedureNotice, false);
  for (const f of [...lights.flairs, ...closure.flairs]) assert.equal(f.evidence.text.length, f.evidence.end - f.evidence.start);
  assert.equal(parseNotam(notice({ text: 'UNKNOWN RWY 09 CLSD' })).flairs.length, 0);
});
test('KSJC-style D and FDC clauses expose scoped facilities, procedure changes and distinct tones', () => {
  const cases: [string, string[]][] = [
    ['RWY 12R RAI LGT U/S', ['RWY 12R', 'RAI Lights Unavailable']],
    ['RWY 30L ALS U/S', ['RWY 30L', 'Approach Lights Unavailable']],
    ['RWY 12R PAPI U/S', ['PAPI Unavailable']],
    ['APRON WEST TXL BTN TWY V4 AND TWY V5 CLSD', ['Taxilane Closed']],
    ['TWY A BTN TWY B AND TWY C CLSD', ['TWY A', 'Taxiway Closed']],
    ['OBST CRANE (ASN 2026-TEST) 380FT (340FT AGL) FLAGGED AND LGTD', ['Crane', 'Flagged and Lighted']],
    ['IAP TEST, CA.\nILS OR LOC RWY 12R, AMDT 9...\nTERMINAL ROUTE: FROM FIXAA (IAF) TO FIXBB (IF) NA.', ['ILS OR LOC RWY 12R', 'Terminal Route Unavailable']],
    ['IAP TEST, CA.\nRNAV (GPS) Y RWY 12R, AMDT 3A...\nLNAV/VNAV DA 479/HAT 433 ALL CATS. LNAV MDA 740/HAT 694 ALL CATS, VIS CATS C/D 1 1/2. SIDESTEP 12L MDA 740/HAT 696 ALL CATS. VDP 1.96NM TO RW12R.', ['Minima Amended', 'Visibility Amended', 'Sidestep Minima', 'VDP Amended']],
    ['IAP TEST, CA.\nRNAV (GPS) Y RWY 30R, AMDT 4B...\nCIRCLING CAT A MDA 660/HAA 598.', ['Minima Amended', 'Circling Minima']],
    ['ODP TEST, CA.\nTAKEOFF MINIMUMS AND (OBSTACLE) DEPARTURE PROCEDURES AMDT 6C...\nTAKE-OFF MINIMUMS RWY 12L, 400-2 1/2 OR STANDARD WITH MINIMUM CLIMB OF 278 FT/NM TO 500.', ['Takeoff Minima Amended', 'Climb Gradient']],
    ['ODP TEST, CA. TAKE-OFF MINIMUMS: RWY 12R, 400-2 1/2 OR STD WITH A MINIMUM CLIMB OF 325 FEET PER NM TO 600, TEMPORARY CRANE.', ['Takeoff Minima Amended', 'Climb Gradient', 'Crane']],
  ];
  for (const [text, expected] of cases) {
    const record = notice({ text }), parsed = parseNotam(record);
    for (const label of expected) assert.ok(parsed.flairs.some(f => f.label === label), `${label}: ${text}`);
    assert.equal(parsed.body, text);
    for (const flair of parsed.flairs) assert.equal(text.slice(flair.evidence.start, flair.evidence.end), flair.evidence.text);
  }
  const [procedure, closure, nav, obstruction, uas] = detailedNotices().map(parseNotam);
  assert.equal(procedure!.flairs.find(f => f.label === 'RNAV (RNP) Z RWY 30L')?.tone, 'procedure');
  assert.equal(procedure!.flairs.find(f => f.label === 'Minima Amended')?.tone, 'caution');
  assert.ok(procedure!.flairs.some(f => f.label === 'Visibility Amended'));
  assert.ok(procedure!.flairs.some(f => f.label === 'Inoperative Lighting Note'));
  assert.ok(!procedure!.flairs.some(f => /unavailable|closed|outage/i.test(f.label)), 'a conditional lighting note is not an actual outage');
  assert.equal(closure!.flairs.find(f => f.label === 'Runway Closed')?.tone, 'danger');
  assert.equal(nav!.flairs.find(f => f.label === 'RWY 30L')?.tone, 'info');
  assert.equal(nav!.flairs.find(f => f.label === 'ILS Unavailable')?.tone, 'caution');
  assert.match(obstruction!.flairs.find(f => f.label === 'Obstacle Light Outage')!.evidence.text, /LGT.*U\/S/);
  assert.ok(uas!.flairs.some(f => f.label === 'Surface to 300 ft AGL'));
});
test('incidental, conditional and unsupported clauses never turn into a facility closure or outage', () => {
  for (const text of [
    'RWY 12R PAPI U/S', 'OBST CRANE NEAR RWY 12R CLSD', 'AD SEE FDC 6/1001 FOR RWY 12R CLSD',
    'IAP TEST. RNAV (GPS) RWY 12R, AMDT 1... WHEN RWY 30L CLSD, CIRCLING NA.',
    'NAV ILS RWY 12R MAY BE U/S', 'RWY 12R WHEN PAPI U/S USE CAUTION',
  ]) assert.ok(!parseNotam(notice({ text })).flairs.some(f => f.tone === 'danger'), text);
  for (const text of ['IAP TEST. RNAV (GPS) RWY 12R, AMDT 1... FOR INOP ALS, INCREASE VISIBILITY TO 1 SM.',
    'NAV ILS RWY 12R MAY BE U/S', 'RWY 12R WHEN PAPI U/S USE CAUTION']) {
    assert.ok(!parseNotam(notice({ text })).flairs.some(f => /unavailable|outage/i.test(f.label)), text);
  }
});
test('bounded heading parsing keeps multiple targets and preserves oversized source text', () => {
  const text = 'IAP TEST. RNAV (GPS) Y RWY 09L, AMDT 2...; ILS OR LOC RWY 09L, ORIG-A...\nMINIMA CHANGED.';
  const parsed = parseNotam(notice({ text }));
  assert.deepEqual(parsed.targets.map(t => [t.title, t.amendment]), [['RNAV (GPS) Y RWY 09L', '2'], ['ILS OR LOC RWY 09L', 'ORIG-A']]);
  for (const target of parsed.targets) assert.equal(text.slice(target.evidence.start, target.evidence.end), target.title);
  const huge = `IAP TEST. ${'X '.repeat(40_000)}, AMDT 2...`;
  const result = parseNotam(notice({ text: huge }));
  assert.equal(result.body, huge); assert.equal(result.unresolved, true); assert.equal(result.targets.length, 0);
  const fallback = parseNotam(notice({ text: '', translations: [{ type: 'LOCAL_FORMAT', text: '!TST 10/001 TST NAV ILS RWY 30L U/S 2610041159-2610051200' }] }));
  assert.ok(fallback.flairs.some(f => f.label === 'ILS Unavailable'));
  for (const flair of fallback.flairs) assert.equal(fallback.body.slice(flair.evidence.start, flair.evidence.end), flair.evidence.text);
});
const selection = procedureSelection(testCatalog, testAirport, testProcedure, testResource.url, 'https://example.test/', testResource);
const context = procedureNoticeContext(selection, testAirport, testProcedure);
test('matching preserves runway side, Y/Z, GPS/RNP and amendment identity', () => {
  const fdc = notice({ classification: 'FDC', text: 'IAP TEST AIRPORT, CA. RNAV (GPS) Y RWY 09L, AMDT 2...\nCIRCLING NA EXC CAT A.' });
  const match = matchPlateNotams([fdc], context).matches[0]!;
  assert.equal(match.outcome, 'applies'); assert.equal(match.parsed.flairs.at(-1)?.label, 'Circling Restriction');
  for (const replacement of ['RNAV (GPS) Z RWY 09L', 'RNAV (GPS) Y RWY 09R', 'RNAV (RNP) Y RWY 09L']) {
    assert.equal(matchPlateNotams([{ ...fdc, text: fdc.text.replace('RNAV (GPS) Y RWY 09L', replacement) }], context).matches.length, 0, replacement);
  }
  assert.equal(matchPlateNotams([{ ...fdc, text: fdc.text.replace('AMDT 2', 'AMDT 3') }], context).matches[0]?.outcome, 'review');
  assert.equal(matchPlateNotams([notice()], context).matches[0]?.outcome, 'applies');
  assert.equal(matchPlateNotams([notice({ text: 'OBST CRANE NEAR RWY 09L' })], context).matches.length, 0);
  assert.equal(matchPlateNotams([notice({ text: 'IAP UNRECOGNIZED PROCEDURE FORMAT' })], context).matches[0]?.outcome, 'review');
  assert.equal(matchPlateNotams([notice({ text: 'IAP ALL IAPS AT TEST AIRPORT NA' })], context).matches[0]?.outcome, 'applies');
  assert.equal(normalizeProcedureTitle('BAYLR SIX (RNAV)', true), normalizeProcedureTitle('BAYLR 6 DEPARTURE', true));
});
test('combined ILS/LOC matches preserve the qualifier and each branch variant and subtype', () => {
  const cases = [
    { combined: 'ILS Z OR LOC Z RWY 09L', included: ['ILS Z RWY 9L', 'LOC Z RWY 09L'],
      excluded: ['ILS Y RWY 09L', 'LOC Y RWY 09L', 'ILS RWY 09L', 'ILS Z RWY 09R'] },
    { combined: 'ILS OR LOC Z RWY 09L', included: ['ILS RWY 09L', 'LOC Z RWY 09L'],
      excluded: ['ILS Z RWY 09L', 'LOC RWY 09L'] },
    { combined: 'HI-ILS Z OR LOC Z RWY 09L', included: ['HI-ILS Z RWY 09L', 'HI-LOC Z RWY 09L'],
      excluded: ['ILS Z RWY 09L', 'LOC Z RWY 09L', 'HI-ILS Y RWY 09L'] },
    { combined: 'COPTER ILS Y OR LOC Y RWY 09L', included: ['COPTER ILS Y RWY 09L', 'COPTER LOC Y RWY 09L'],
      excluded: ['ILS Y RWY 09L', 'LOC Y RWY 09L', 'COPTER ILS Z RWY 09L'] },
    { combined: 'ILS OR LOC/DME RWY 09L', included: ['ILS RWY 09L', 'LOC/DME RWY 09L'],
      excluded: ['ILS/DME RWY 09L', 'LOC RWY 09L', 'RNAV (GPS) RWY 09L'] },
  ];
  const record = (name: string) => notice({ classification: 'FDC', text: `IAP TEST. ${name}, AMDT 2... MINIMA CHANGED.` });
  const plate = (name: string) => ({ ...context, procedure: { ...testProcedure, name } });
  for (const { combined, included, excluded } of cases) {
    for (const branch of included) {
      assert.equal(matchPlateNotams([record(branch)], plate(combined)).matches[0]?.outcome, 'applies', `${branch} notice on ${combined}`);
      assert.equal(matchPlateNotams([record(combined)], plate(branch)).matches[0]?.outcome, 'applies', `${combined} notice on ${branch}`);
    }
    for (const branch of excluded) {
      assert.equal(matchPlateNotams([record(branch)], plate(combined)).matches.length, 0, `${branch} notice on ${combined}`);
      assert.equal(matchPlateNotams([record(combined)], plate(branch)).matches.length, 0, `${combined} notice on ${branch}`);
    }
  }
});
test('time interpretation never guesses schedules, estimated ends or permanent expiry', () => {
  assert.equal(notamValidity(notice({ startsAt: NOTAM_NOW + 1 }), NOTAM_NOW), 'upcoming');
  assert.equal(notamValidity(notice({ schedule: 'SR-SS' }), NOTAM_NOW), 'check schedule');
  assert.equal(notamValidity(notice({ endsAt: NOTAM_NOW, endKind: 'estimated' }), NOTAM_NOW), 'check validity');
  assert.equal(notamValidity(notice({ endsAt: null, endKind: 'permanent' }), NOTAM_NOW), 'within interval');
  const scheduled = notice({ startsAt: NOTAM_NOW - 86_400_000, endsAt: NOTAM_NOW + 7 * 86_400_000, schedule: 'MON-FRI 2200-0200' });
  assert.equal(notamValidity(scheduled, Date.parse('2026-10-06T01:00:00Z')), 'within interval');
  assert.equal(notamValidity(scheduled, Date.parse('2026-10-05T01:00:00Z')), 'outside schedule');
  assert.equal(notamValidity({ ...scheduled, schedule: 'DLY 2460-2500' }, NOTAM_NOW), 'check schedule');
  const daily = { ...scheduled, schedule: 'Daily:1500-0500~DLY 1500-0500' };
  assert.equal(notamValidity(daily, Date.parse('2026-10-05T02:00:00Z')), 'within interval');
  assert.equal(notamValidity(daily, Date.parse('2026-10-05T05:00:00Z')), 'outside schedule');
  assert.equal(notamValidity({ ...daily, schedule: 'Daily:1500-0500~DLY 1500-0600' }, NOTAM_NOW), 'check schedule');
  assert.equal(notamValidity({ ...daily, schedule: 'MON TUE WED THU FRI' }, NOTAM_NOW), 'check schedule');
});
test('estimated validity survives translations, multipart footers and saved fixed-end records', () => {
  const range = '2610041159-2610051200EST';
  for (const record of [
    notice({ text: `RWY 09L CLSD ${range}\nEND PART 1 OF 2` }),
    notice({ translations: [{ type: 'LOCAL_FORMAT', text: `!TST 10/001 TST RWY 09L CLSD ${range}\nEND PART 2 OF 2` }] }),
    notice({ effectiveEnd: '2026-10-05T12:00:59Z', translations: [{ type: 'ICAO', text: range }] }),
  ]) {
    assert.equal(notamEndKind(record), 'estimated');
    assert.equal(notamValidity(record, NOTAM_NOW + 2 * 86_400_000), 'check validity');
  }
  const conflict = notice({ text: 'RWY 09L CLSD 2610041159-2610061200EST' });
  assert.equal(notamEndKind(conflict), 'unknown');
  assert.equal(notamValidity(conflict, NOTAM_NOW + 2 * 86_400_000), 'check validity');
  assert.equal(notamEndKind(notice({ text: 'TWY EST WORK AREA CLSD' })), 'fixed');
  assert.equal(notamValidity(notice(), NOTAM_NOW + 2 * 86_400_000), 'past end');
});
test('approach identities preserve HI and unknown prefixes cannot become ordinary targets', () => {
  for (const amendment of ['', ', AMDT 2...']) {
    const record = notice({ classification: 'FDC', text: `IAP TEST. HI-ILS Z OR LOC Z RWY 09L${amendment}\nMINIMA CHANGED.` });
    assert.equal(parseNotam(record).targets[0]?.title, 'HI-ILS Z OR LOC Z RWY 09L');
    const ordinary = { ...context, procedure: { ...testProcedure, name: 'ILS Z OR LOC Z RWY 09L' } };
    assert.equal(matchPlateNotams([record], ordinary).matches.length, 0);
    assert.equal(matchPlateNotams([record], { ...ordinary, procedure: { ...ordinary.procedure, name: 'HI-ILS Z OR LOC Z RWY 09L' } }).matches[0]?.outcome, 'applies');
  }
  const unknown = notice({ text: 'IAP TEST. SPECIAL RNAV (GPS) Y RWY 09L, AMDT 2... MINIMA CHANGED.' });
  assert.equal(parseNotam(unknown).targets.length, 0);
  assert.equal(matchPlateNotams([unknown], context).matches[0]?.outcome, 'review');
});
test('explicit runway navigation outages match only supported approach dependencies', () => {
  const ils = { ...context, procedure: { ...testProcedure, name: 'ILS OR LOC RWY 09L' } };
  const loc = { ...context, procedure: { ...testProcedure, name: 'LOC RWY 09L' } };
  for (const facility of ['ILS', 'LOC', 'GS', 'GP']) {
    const record = notice({ text: `NAV ${facility} RWY 9L U/S` });
    assert.equal(matchPlateNotams([record], ils).matches[0]?.outcome, 'applies');
    assert.equal(matchPlateNotams([record], context).matches.length, 0, 'RNAV is not presumed to use ILS');
    assert.equal(matchPlateNotams([record], loc).matches.length, ['GS', 'GP'].includes(facility) ? 0 : 1);
    assert.equal(matchPlateNotams([record], { ...ils, procedure: { ...ils.procedure, name: 'ILS RWY 09R' } }).matches.length, 0);
  }
  assert.equal(matchPlateNotams([notice({ text: 'NAV ILS U/S' })], ils).unresolved, 1);
  assert.equal(matchPlateNotams([notice({ text: 'NAV VOR RWY 09L U/S' })], ils).matches[0]?.outcome, 'review');
});
test('qualified all-approach notices require review even when they name the displayed approach', () => {
  for (const qualifier of ['EXCEPT RNAV (GPS) Y RWY 09L', 'EXC RNAV (GPS) Y RWY 09L', 'ONLY WHEN TOWER CLOSED']) {
    const record = notice({ classification: 'FDC', text: `IAP ALL IAPS NA ${qualifier}.` });
    assert.equal(parseNotam(record).broadRestricted, true);
    const result = matchPlateNotams([record], context);
    assert.equal(result.matches[0]?.outcome, 'review');
    assert.equal(result.unresolved, 1);
  }
});
test('multiple named SID/STAR headings match revisions; incidental approach names stay unconfirmed', () => {
  const procedure = { ...testProcedure, kind: 'departure' as const, name: 'DALLAS FOUR' };
  const context = procedureNoticeContext(selection, testAirport, procedure);
  const record = notice({ classification: 'FDC', text: 'SID TEST AIRPORT, CA.\nDALLAS FOUR DEPARTURE...\nGARLAND SIX DEPARTURE...\nWEST TRANSITION NA EXCEPT GPS.' });
  assert.deepEqual(parseNotam(record).targets.map(t => t.title), ['DALLAS FOUR', 'GARLAND SIX']);
  assert.equal(matchPlateNotams([record], context).matches[0]?.outcome, 'applies');
  assert.equal(matchPlateNotams([record], { ...context, procedure: { ...procedure, name: 'DALLAS FIVE' } }).matches.length, 0);
  const incidental = notice({ classification: 'FDC', text: 'IAP TEST. MISSED APPROACH: PROCEED VIA RNAV (GPS) Y RWY 09L, AMDT 2...' });
  assert.equal(parseNotam(incidental).targets.length, 0);
  const ils = notice({ classification: 'FDC', text: 'IAP TEST. ILS RWY 9L, AMDT 2... MINIMA CHANGED.' });
  const combined = procedureNoticeContext(selection, testAirport, { ...testProcedure, name: 'ILS OR LOC RWY 09L' });
  assert.equal(matchPlateNotams([ils], combined).matches[0]?.outcome, 'applies');
  assert.equal(matchPlateNotams([{ ...record, classification: 'INTL' }], context).matches.length, 0);
});
test('actual book page resolves its own airport; missing/ambiguous/other-edition pages never inherit selection', () => {
  assert.equal(resolvePlateNoticeContext(selection, 0, testCatalog).airport?.faaId, 'TST');
  assert.equal(resolvePlateNoticeContext(selection, 1, testCatalog).status, 'unavailable');
  const other = { ...testAirport, id: 'PANC', faaId: 'ANC', icaoId: 'PANC', procedures: [{ ...testProcedure,
    volumeTarget: { ...testProcedure.volumeTarget!, pageIndex: 1 } }] };
  const catalog = { ...testCatalog, airports: [...testCatalog.airports, other] };
  assert.deepEqual(resolvePlateNoticeContext(selection, 1, catalog).airport, { faaId: 'ANC', icaoId: 'PANC' });
  assert.equal(resolvePlateNoticeContext(selection, 1, { ...catalog, airports: [...catalog.airports, other] }).status, 'unavailable');
  assert.equal(resolvePlateNoticeContext(selection, 0, { ...testCatalog, cycle: '2609' }).status, 'unavailable');
  assert.equal(resolvePlateNoticeContext({ ...selection, catalog: undefined } as unknown as typeof selection, 0, catalog).status, 'unavailable');
});
test('one client coalesces consumers, preserves failure/offline data and releases obsolete work', async t => {
  let calls = 0, time = NOTAM_NOW, fail = false;
  const client = createNotamsClient({ now: () => time, debounceMs: 0,
    storage: { read: () => [notamSnapshot()], write() { throw new Error('Storage denied'); } },
    load: async (query, signal) => { signal.throwIfAborted(); calls++; if (fail) throw new Error(); return notamSnapshot(undefined, { query }); } });
  client.start(); t.after(client.stop);
  const a = client.retain({ faaId: 'TST', icaoId: 'KTST' }, true), b = client.retain({ faaId: 'TST', icaoId: 'KTST' }, true);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1);
  a(); b(); time += 180_000; client.retain({ faaId: 'TST', icaoId: 'KTST' }, false);
  assert.equal(client.state.getSnapshot().now, time, 'reopening updates saved validity immediately');
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 1);
  time += 180_000; fail = true; client.retain({ faaId: 'TST', icaoId: 'KTST' }, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  const entry = client.state.getSnapshot().airports[notamAirportKey({ faaId: 'TST', icaoId: 'KTST' })]!;
  assert.ok(entry.error); assert.equal(entry.snapshot?.feed.checkedAt, NOTAM_NOW);
});
test('reopening and adding airports preserve each demanded airport refresh deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOTAM_NOW });
  const calls: [string, number][] = [];
  const client = createNotamsClient({ debounceMs: 0, storage: { read: () => [], write() {} },
    load: async query => { calls.push([query.faaId!, Date.now() - NOTAM_NOW]); return notamSnapshot([], { query }); } });
  t.after(client.stop);
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  client.start();
  const first = client.retain({ faaId: 'TST' }, true);
  await advance(0); first();
  await advance(NOTAM_REFRESH_MS - 1000);
  const reopened = client.retain({ faaId: 'TST' }, true);
  const other = client.retain({ faaId: 'ANC' }, true);
  await advance(0);
  assert.deepEqual(calls, [['TST', 0], ['ANC', NOTAM_REFRESH_MS - 1000]], 'reopening reuses the still-fresh airport');
  await advance(999); assert.equal(calls.length, 2);
  await advance(1);
  assert.deepEqual(calls.at(-1), ['TST', NOTAM_REFRESH_MS], 'TST keeps its deadline despite the changed demand');
  await advance(NOTAM_REFRESH_MS - 1000);
  assert.deepEqual(calls.at(-1), ['ANC', 2 * NOTAM_REFRESH_MS - 1000], 'ANC keeps its own deadline');
  assert.equal(calls.length, 4);
  await advance(1000);
  assert.deepEqual(calls.at(-1), ['TST', 2 * NOTAM_REFRESH_MS]);
  reopened(); other();
  await advance(2 * NOTAM_REFRESH_MS);
  assert.equal(calls.length, 5, 'released demand has no recurring reads');
});
test('reactivation replaces an aborted first read immediately and ignores its late response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOTAM_NOW });
  const requests: { signal: AbortSignal; finish(snapshot: ReturnType<typeof notamSnapshot>): void }[] = [];
  const client = createNotamsClient({ debounceMs: 0, storage: { read: () => [], write() {} },
    load: (_query, signal) => new Promise(resolve => requests.push({ signal, finish: resolve })) });
  t.after(client.stop);
  const query = { faaId: 'TST' }, key = notamAirportKey(query);
  client.start(); client.retain(query, true);
  t.mock.timers.tick(0); await flush();
  assert.equal(requests.length, 1);
  client.stop(); assert.equal(requests[0]!.signal.aborted, true);
  client.start(); const release = client.retain(query, true);
  t.mock.timers.tick(0); await flush();
  assert.equal(requests.length, 2, 'the cancelled attempt must not throttle the new activation');
  const fresh = notamSnapshot([notice({ text: 'RWY 09L CLSD' })], { query });
  requests[1]!.finish(fresh); await flush();
  requests[0]!.finish(notamSnapshot([], { query })); await flush();
  assert.equal(client.state.getSnapshot().airports[key]?.snapshot, fresh, 'late completion cannot replace the live snapshot');
  release(); client.retain(query, true);
  t.mock.timers.tick(0); await flush();
  assert.equal(requests.length, 2, 'late cleanup must not erase the successful replacement deadline');
});
test('a late client response cannot replace an airport or resurrect an unloaded activation', async () => {
  let finish!: (value: ReturnType<typeof notamSnapshot>) => void;
  const client = createNotamsClient({ now: () => NOTAM_NOW, debounceMs: 0, storage: { read: () => [], write() {} },
    load: () => new Promise(resolve => { finish = resolve; }) });
  client.start(); client.retain({ faaId: 'TST' }, true);
  await new Promise(resolve => setTimeout(resolve, 10)); client.stop(); client.start();
  finish(notamSnapshot(undefined, { query: { faaId: 'TST' } }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(client.state.getSnapshot().airports[notamAirportKey({ faaId: 'TST' })]?.snapshot, undefined);
  client.stop();
});
