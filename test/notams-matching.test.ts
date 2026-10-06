import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isNotamAirportSnapshot, isProcedureCatalog, type NotamRecord, type ProcedureRecord } from '@zlayer/contracts';
import { parseNotam } from '../src/layers/notams/parser';
import { approachTitleKey } from '../src/layers/notams/procedure-title';
import { matchPlateNotams, normalizeProcedureAmendment, procedureTargetMatch } from '../src/layers/notams/matcher';
import { PlateNotamResults } from '../src/layers/notams/ui';
import { procedureNoticeContext, resolvePlateNoticeContext } from '../src/layers/plates/page-context';
import { procedureSelection } from '../src/layers/plates/data';
import { auditNotam, auditRenderedNotam } from '../tools/audit-notams';
import { notice, testAirport, testCatalog, testProcedure, testResource, NOTAM_NOW } from './fixtures/notams';

const fixture = new URL('./fixtures/notams-us1000/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixture), 'utf8'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const corpusBytes = gunzipSync(readFileSync(new URL(manifest.payload.file, fixture)));
assert.equal(digest(corpusBytes), manifest.payload.sha256);
const snapshots = corpusBytes.toString().trimEnd().split('\n').map(line => {
  const value: unknown = JSON.parse(line); assert(isNotamAirportSnapshot(value)); return value;
});
const catalogBytes = gunzipSync(readFileSync(new URL(manifest.plateCatalog.file, fixture)));
assert.equal(catalogBytes.length, manifest.plateCatalog.bytes);
assert.equal(digest(catalogBytes), manifest.plateCatalog.sha256);
const catalog: unknown = JSON.parse(catalogBytes.toString());
assert(isProcedureCatalog(catalog));
const resource = { ...testResource, url: manifest.plateCatalog.url, cycle: catalog.cycle,
  effectiveDate: catalog.effectiveDate, expirationDate: catalog.expirationDate };
const airport = (faa: string) => { const a = catalog.airports.find(a => a.faaId === faa); assert(a, faa); return a; };
const captured = (faa: string, number: string, classification = 'FDC'): NotamRecord => {
  const candidates = snapshots.find(s => s.query.faaId === faa)!.records.filter(r => r.classification === classification && r.number === number);
  assert.equal(candidates.length, 1, `${faa} ${number}`); return candidates[0]!;
};
const contextFor = (faa: string, plate: ProcedureRecord) => {
  const a = airport(faa);
  return procedureNoticeContext(procedureSelection(catalog, a, plate, resource.url, resource.url, resource), a, plate);
};
const plateFor = (faa: string, name: string) => { const p = airport(faa).procedures.find(p => p.name === name); assert(p, `${faa}: ${name}`); return p; };
function expectedMatches(faa: string, number: string, expected: string[], classification = 'FDC') {
  const record = captured(faa, number, classification), before = JSON.stringify(record);
  const actual = airport(faa).procedures.filter(p => p.source.userAction !== 'D').flatMap(p =>
    matchPlateNotams([record], contextFor(faa, p)).matches.map(m => `${p.name}: ${m.outcome}`));
  assert.deepEqual(actual.sort(), expected.sort(), `${faa} ${number}`);
  for (const item of [...parseNotam(record).targets, ...parseNotam(record).facts]) assert.equal(parseNotam(record).body.slice(item.evidence.start, item.evidence.end), item.evidence.text);
  assert.deepEqual(auditNotam(record), []);
  assert.deepEqual(auditRenderedNotam(record, false, manifest.capture.reviewTime), []);
  assert.equal(JSON.stringify(record), before);
}

test('captured spelling, PRM, shared-category and heading cases match every expected plate', () => {
  expectedMatches('OAK', '6268', ['ILS OR LOC RWY 12: applies', 'ILS RWY 12 (SA CAT I): applies']);
  expectedMatches('ORD', '9281', ['RNAV (GPS) Y RWY 10R: applies']);
  expectedMatches('ATL', '5012', ['ILS OR LOC RWY 10: applies', 'ILS RWY 10 (SA CAT I): applies',
    'ILS PRM RWY 10: applies', 'ILS PRM RWY 10 (SA CAT I): applies', 'ILS PRM RWY 10 (CAT II - III): applies']);
  expectedMatches('HRL', '7926', ['ILS OR LOC RWY 18R: applies', 'ILS RWY 18R (SA CAT I - II): applies']);
  expectedMatches('HRL', '9028', ['ILS OR LOC RWY 36L: applies', 'ILS RWY 36L (SA CAT I - II): applies']);
  expectedMatches('STL', '3246', ['ILS RWY 12L (CAT II - III): applies']);
  expectedMatches('CLE', '6389', ['ILS OR LOC RWY 06L: applies', 'ILS RWY 06L (CAT II - III): applies']);
  expectedMatches('OMA', '8689', ['ILS RWY 14R (CAT II - III): applies']);
  expectedMatches('HNL', '2075', ['KAENA FIVE (RNAV): applies', 'KAENA FIVE (RNAV), CONT.1: applies']);
  expectedMatches('ORD', '4301', ['ILS RWY 09C (CAT II - III): applies']);
  expectedMatches('CLT', '690', ['RNAV (GPS) Y RWY 01L: review']);
});

test('original amendments compare by edition while preserving different letters and unknown metadata', () => {
  for (const [left, right] of [['ORIG', '0'], ['ORIG-A', '0A'], ['AMDT ORIG-B', '0B'], ['AMDT 8B', '8B']])
    assert.equal(normalizeProcedureAmendment(left!), normalizeProcedureAmendment(right!));
  assert.notEqual(normalizeProcedureAmendment('ORIG-B'), normalizeProcedureAmendment('0C'));
  const record = captured('ORD', '9281'), original = plateFor('ORD', 'RNAV (GPS) Y RWY 10R');
  for (const amendmentNumber of ['0C', '1', null]) {
    const p = { ...original, source: { ...original.source, amendmentNumber } };
    assert.equal(matchPlateNotams([record], contextFor('ORD', p)).matches[0]?.outcome, 'review');
  }
});

test('scope overlap does not erase category, special authorization, PRM or runway distinctions', () => {
  const plate = (name: string) => ({ ...testProcedure, name });
  const combined = plate('ILS RWY 09L (SA CAT I-II)');
  assert.notEqual(approachTitleKey('ILS RWY 09L (SA CAT I)'), approachTitleKey(combined.name));
  assert.deepEqual(procedureTargetMatch('ILS RWY 9L (SAT CAT I)', 'IAP', combined), { scope: 'SA CAT I' });
  assert.deepEqual(procedureTargetMatch('ILS RWY 9L (SA CAT II)', 'IAP', combined), { scope: 'SA CAT II' });
  for (const title of ['ILS RWY 9L CAT I', 'ILS RWY 9L SA CAT III', 'ILS RWY 9R SA CAT I', 'ILS Z RWY 9L SA CAT I',
    'ILS PRM RWY 9L SA CAT I', 'ILS RWY 9L SAT CAT II', 'RNAV (GPS) RWY 9L SA CAT I'])
    assert.equal(procedureTargetMatch(title, 'IAP', combined), undefined, title);
  const record = notice({ classification: 'FDC', text: 'IAP TEST. ILS RWY 09L (SA CAT I), AMDT 2... ILS RWY 09L (SA CAT II), AMDT 3... PROCEDURE NA.' });
  const context = procedureNoticeContext(procedureSelection(testCatalog, testAirport, combined, testResource.url, testResource.url), testAirport, combined);
  assert.equal(matchPlateNotams([record], context).matches[0]?.outcome, 'review', 'a later matching heading has a different amendment');
});

test('takeoff, named obstacle departures, DVA and radar notices use their actual catalog kinds', () => {
  expectedMatches('ORD', '9517', ['TAKEOFF MINIMUMS: review']);
  expectedMatches('HNL', '6596', ['HONOLULU TWO (OBSTACLE): applies', 'HONOLULU TWO (OBSTACLE), CONT.1: applies']);
  expectedMatches('IWA', '7315', ['PHOENIX ONE (OBSTACLE): applies']);
  for (const [faa, number] of [['PHX', '2620'], ['APA', '5644'], ['ABQ', '9587'], ['EMT', '5688'], ['SBA', '1529'],
    ['BOS', '9664'], ['IWA', '7313']]) expectedMatches(faa!, number!, ['DIVERSE VECTOR AREA: review']);
  for (const [faa, number] of [['TUL', '2375'], ['DLH', '1009'], ['MOB', '1614'], ['PSM', '1100'], ['HUF', '3934'],
    ['PWA', '9565'], ['RFD', '7398'], ['EVV', '3790'], ['PWG', '1925'], ['CYS', '524'], ['LCH', '521']]) {
    const p = plateFor(faa!, 'RADAR MINIMUMS');
    const result = matchPlateNotams([captured(faa!, number!)], contextFor(faa!, p));
    assert.equal(result.matches[0]?.outcome, 'review', `${faa} ${number}: unavailable catalog amendment`);
    assert.match(result.matches[0]!.reason, /displayed plate unknown/);
  }
});

test('multipart subjects and first-part headings are recognized without assembling numeric clauses', () => {
  for (const [faa, number, subject] of [['MIA', '1519', 'ODP'], ['IAD', '7644', 'ODP'], ['OAK', '5325', 'ODP'], ['SUS', '5681', 'ODP'], ['IWA', '2812', 'IAP']]) {
    const record = captured(faa!, number!), parsed = parseNotam(record);
    assert.equal(parsed.subject, subject);
    assert.ok(parsed.issues.includes('multipart'));
    assert.equal(parsed.targets.length, 1);
    assert.ok(!parsed.facts.some(f => ['minima', 'visibility', 'climb', 'takeoff'].includes(f.kind)));
    assert.deepEqual(auditNotam(record), []);
    assert.deepEqual(auditRenderedNotam(record, false, manifest.capture.reviewTime), []);
  }
  expectedMatches('IWA', '2812', ['VOR OR TACAN RWY 30C: applies']);
  for (const text of ['PART 2 OF 2 IAP TEST. ILS RWY 09L, AMDT 2...',
    'PART 1 OF 2 NOTE IAP TEST. ILS RWY 09L, AMDT 2...']) assert.equal(parseNotam(notice({ text })).targets.length, 0);
  const first = parseNotam(notice({ text: 'PART 1 OF 2 IAP TEST. ILS RWY 09L, AMDT 2... END PART 1 OF 2 PART 2 OF 2 ILS RWY 27R, AMDT 2...' }));
  assert.deepEqual(first.targets.map(t => t.title), ['ILS RWY 09L']);
  const ena = parseNotam(captured('ENA', '6295'));
  assert.deepEqual(ena.targets.map(t => [t.title, t.amendment]), [['RNAV (GPS) N RWY 03', 'ORIG'], ['RNAV (GPS) N RWY 21', 'ORIG']]);
  assert.equal(parseNotam(captured('RBG', '1630')).targets.length, 3);
  assert.equal(parseNotam(captured('ENA', '6298')).targets[0]?.amendment, 'ORIG');
  assert.ok(parseNotam(captured('HIO', '6527')).issues.includes('headings'), 'missing amendment value stays limited');
});

test('NAV category restrictions match only the stated runway and authorization categories', () => {
  for (const [text, included, excluded] of [
    ['NAV ILS RWY 09L CAT II/III NA', ['ILS RWY 09L (CAT II-III)', 'ILS RWY 09L CAT II'], ['ILS OR LOC RWY 09L', 'ILS RWY 09R CAT II', 'ILS RWY 09L SA CAT II']],
    ['NAV ILS RWY 09L SPECIAL AUTH CAT II NA', ['ILS RWY 09L (SA CAT I-II)'], ['ILS RWY 09L CAT II', 'ILS RWY 09L SA CAT I', 'RNAV (GPS) RWY 09L']],
  ] as const) {
    const record = notice({ text }), parsed = parseNotam(record);
    assert.deepEqual(parsed.issues, []);
    assert.ok(!parsed.facts.some(f => f.label === 'ILS Unavailable'));
    for (const name of [...included, ...excluded]) {
      const p = { ...testProcedure, name }, c = procedureNoticeContext(procedureSelection(testCatalog, testAirport, p, testResource.url, testResource.url), testAirport, p);
      assert.equal(matchPlateNotams([record], c).matches.length, (included as readonly string[]).includes(name) ? 1 : 0, name);
    }
  }
  for (const text of ['NAV ILS RWY 09L IF CAT II NA', 'NAV ILS RWY 09L CAT II MAY BE NA', 'NAV ILS RWY 09L CAT IV NA'])
    assert.equal(parseNotam(notice({ text })).categoryTarget, undefined);
  const record = notice({ text: 'NAV ILS RWY 09L CAT II/III NA' });
  const p = { ...testProcedure, name: 'ILS OR LOC RWY 09L' };
  const c = procedureNoticeContext(procedureSelection(testCatalog, testAirport, p, testResource.url, testResource.url), testAirport, p);
  const missing = matchPlateNotams([record], { ...c, procedures: [p] });
  assert.equal(missing.matches.length, 0);
  assert.equal(missing.unresolved, 1, 'a parsed category restriction with no catalog category is still a coverage gap');
  assert.deepEqual(missing.unmatchedTargets[0]?.titles, ['ILS RWY 9L (CAT II/III)']);
});

test('documented VOR/DME title transitions are review candidates without erasing identity or equipment requirements', () => {
  expectedMatches('HUM', '536', ['COPTER VOR RWY 12: review']);
  expectedMatches('BIL', '6164', ['HI-ILS Z OR LOC Z RWY 10L: review', 'HI-VOR OR TACAN RWY 28R: review']);
  expectedMatches('BIL', '7064', ['HI-ILS Z OR LOC Z RWY 10L: review', 'HI-VOR OR TACAN RWY 28R: review',
    'ILS OR LOC RWY 28R: applies', 'ILS Y OR LOC Y RWY 10L: applies', 'VOR/DME RWY 28R: applies']);
  assert.notEqual(approachTitleKey('VOR/DME-A'), approachTitleKey('VOR-A'));
  const p = { ...testProcedure, name: 'VOR-A' };
  assert.match(procedureTargetMatch('VOR/DME-A', 'IAP', p)?.review ?? '', /equipment notes/);
  for (const title of ['HI-VOR/DME-A', 'COPTER VOR/DME-A', 'VOR/DME-B', 'VOR/DME RWY 01', 'NDB/DME-A', 'LOC/DME-A', 'VOR/DME OR TACAN-A'])
    assert.equal(procedureTargetMatch(title, 'IAP', p), undefined, title);
  assert.equal(procedureTargetMatch('VOR-A', 'IAP', { ...p, name: 'VOR/DME-A' }), undefined, 'do not assume the reverse transition');
});

test('captured NAV restrictions include every corresponding category plate and expose missing categories', () => {
  expectedMatches('ORD', '823', ['ILS RWY 28R (CAT II - III): applies'], 'DOMESTIC');
  expectedMatches('ATL', '67', ['ILS RWY 27L (CAT II): applies', 'ILS PRM RWY 27L (CAT II): applies'], 'DOMESTIC');
  expectedMatches('IAH', '78', ['ILS RWY 09 (SA CAT I - II): applies'], 'DOMESTIC');
  for (const [faa, number] of [['IAD', '239'], ['COS', '104'], ['ICT', '80']]) {
    expectedMatches(faa!, number!, [], 'DOMESTIC');
    const result = matchPlateNotams([captured(faa!, number!, 'DOMESTIC')], contextFor(faa!, airport(faa!).procedures.find(p => p.kind === 'approach')!));
    assert.equal(result.unresolved, 1, `${faa}: recognized restriction absent from this catalog`);
  }
});

test('HSV category overlap retains its CAT II match and exposes the missing CAT III reference', () => {
  const record = captured('HSV', '5', 'DOMESTIC'), p = plateFor('HSV', 'ILS RWY 18R (CAT II)');
  expectedMatches('HSV', '5', ['ILS RWY 18R (CAT II): applies'], 'DOMESTIC');
  const result = matchPlateNotams([record], contextFor('HSV', p));
  assert.equal(result.matches[0]?.outcome, 'applies');
  assert.match(result.matches[0]!.reason, /Explicit CAT II restriction/);
  assert.equal(result.unresolved, 1);
  assert.deepEqual(result.unmatchedTargets.map(g => g.titles), [['ILS RWY 18R (CAT III)']]);
});

test('category coverage requires every authorization and category, including across separate plates', () => {
  const title = 'ILS RWY 09L (SA CAT I-II) (CAT II-III)';
  const record = notice({ classification: 'FDC', text: `IAP TEST. ${title}, AMDT 2... PROCEDURE NA.` });
  const plate = (name: string): ProcedureRecord => ({ ...testProcedure, id: name, name });
  const specialI = plate('ILS RWY 09L (SA CAT I)'), standardII = plate('ILS RWY 09L (CAT II)');
  const selection = procedureSelection(testCatalog, testAirport, specialI, testResource.url, testResource.url);
  const context = { ...procedureNoticeContext(selection, testAirport, specialI), procedures: [specialI, standardII,
    plate('ILS RWY 09L (SA CAT III)'), plate('ILS RWY 09R (CAT III)'), plate('ILS Z RWY 09L (CAT III)'),
    plate('ILS PRM RWY 09L (CAT III)')] };
  const partial = matchPlateNotams([record], context);
  assert.equal(partial.matches[0]?.outcome, 'applies');
  assert.equal(partial.unresolved, 1);
  assert.deepEqual(partial.unmatchedTargets[0]?.titles, [
    `${title} · Unmatched SA CAT II`, `${title} · Unmatched CAT III`,
  ]);
  const complete = { ...context, procedures: [...context.procedures, plate('ILS RWY 09L (SA CAT II)'), plate('ILS RWY 09L (CAT III)')] };
  assert.deepEqual(matchPlateNotams([record], complete).unmatchedTargets, []);
  assert.equal(matchPlateNotams([record], complete).unresolved, 0);
  const continuation = { ...context, procedures: [plate(`${title}, CONT.1`)] };
  assert.equal(matchPlateNotams([record], continuation).unresolved, 0, 'recognized continuation titles retain their categories');
  const nav = notice({ text: 'NAV ILS RWY 09L SPECIAL AUTH CAT I/II NA' });
  assert.deepEqual(matchPlateNotams([nav], context).unmatchedTargets[0]?.titles, ['ILS RWY 9L (SA CAT II)']);
  assert.equal(matchPlateNotams([nav], complete).unresolved, 0);
});

test('airport reference coverage is reused across plate contexts and invalidated by source replacements', () => {
  const record = notice({ classification: 'FDC', text: 'IAP TEST. ILS RWY 09L (CAT II/III), AMDT 2... PROCEDURE NA.' });
  const plate = (name: string): ProcedureRecord => ({ ...testProcedure, id: name, name });
  const selected = plate('ILS RWY 09L (CAT II)'), other = plate('ILS RWY 18');
  let catalogReads = 0;
  const counted = { ...plate('ILS RWY 09L (CAT I)'), get name() { catalogReads++; return 'ILS RWY 09L (CAT I)'; } };
  const a = { ...testAirport, procedures: [selected, other, counted] };
  const context = (procedure: ProcedureRecord, airport = a) => procedureNoticeContext(
    procedureSelection(testCatalog, airport, procedure, testResource.url, testResource.url), airport, procedure);
  assert.equal(matchPlateNotams([record], context(selected)).unresolved, 1);
  const initialReads = catalogReads;
  assert.ok(initialReads > 0);
  for (const p of [other, selected, other]) assert.equal(matchPlateNotams([record], context(p)).unresolved, 1);
  assert.equal(catalogReads, initialReads, 'other catalog entries are not rescanned for each row or clock update');

  const replacement = { ...record, text: 'IAP TEST. ILS RWY 09L (CAT I), AMDT 2... PROCEDURE NA.' };
  assert.equal(matchPlateNotams([replacement], context(selected)).unresolved, 0);
  assert.ok(catalogReads > initialReads, 'a replacement record with the same source ID is recomputed');

  const standardIII = plate('ILS RWY 09L (CAT III)');
  const revised = { ...a, procedures: [...a.procedures, standardIII] };
  assert.equal(matchPlateNotams([record], context(selected, revised)).unresolved, 0, 'a replacement catalog clears the old gap');
  const deleted = { ...a, procedures: [...a.procedures, { ...standardIII, source: { ...standardIII.source, userAction: 'D' } }] };
  assert.equal(matchPlateNotams([record], context(selected, deleted)).unresolved, 1, 'deleted entries cannot satisfy coverage');
  assert.equal(matchPlateNotams([record], context(selected)).unresolved, 1, 'another edition cannot change the original coverage');
});

test('shared minimums pages use exact indexed airport/section choices and never inherit after paging', () => {
  const a = airport('PHX'), p = plateFor('PHX', 'DIVERSE VECTOR AREA');
  const selection = procedureSelection(catalog, a, p, resource.url, resource.url, resource);
  const own = resolvePlateNoticeContext(selection, selection.document.pageIndex, catalog);
  assert.equal(own.status, 'resolved'); assert.equal(own.airport?.faaId, 'PHX'); assert.equal(own.procedure?.kind, 'diverse-vector-area');
  assert(own.sharedPage && own.choices && own.choices.length > 1);
  const takeoff = own.choices.find(c => c.airport?.faaId === 'PHX' && c.procedure?.kind === 'takeoff-minimums')!;
  const takeoffSelection = procedureSelection(catalog, a, takeoff.procedure!, resource.url, resource.url, resource);
  const reopened = resolvePlateNoticeContext(takeoffSelection, takeoffSelection.document.pageIndex, catalog);
  assert.notEqual(reopened.key, own.key, 'opening another section on the same page resets a previous manual choice');
  assert.equal(reopened.procedure?.kind, 'takeoff-minimums');
  assert.equal(matchPlateNotams([captured('PHX', '2620')], takeoff).matches.length, 0);
  const otherPage = resolvePlateNoticeContext(selection, plateFor('IWA', 'DIVERSE VECTOR AREA').volumeTarget!.pageIndex!, catalog);
  assert.equal(otherPage.status, 'unavailable'); assert.equal(otherPage.airport, undefined);
  assert(otherPage.choices?.some(c => c.airport?.faaId === 'IWA'));
  const wrongAirport = captured('APA', '5644');
  assert.equal(matchPlateNotams([wrongAirport], own).matches.length, 0);
  assert.equal(resolvePlateNoticeContext({ ...selection, cycle: '2609' }, selection.document.pageIndex, catalog).status, 'unavailable');
});

test('a matched sibling cannot hide a missing heading, and all airport records remain accessible', () => {
  const record = captured('OMA', '4273'), p = plateFor('OMA', 'ILS OR LOC RWY 32R');
  const result = matchPlateNotams([record], contextFor('OMA', p));
  assert.equal(result.matches[0]?.outcome, 'applies');
  assert.deepEqual(result.unmatchedTargets.map(g => g.titles), [['ILS RWY 32R (SA CAT I)']]);
  assert.equal(result.unresolved, 1);
  const html = renderToStaticMarkup(createElement(PlateNotamResults, { records: [record], result, now: manifest.capture.reviewTime }));
  assert.match(html, /Matching is incomplete/); assert.match(html, /Unmatched procedure references/);
  assert.doesNotMatch(html, /Show remaining airport NOTAMs/);
  assert.match(html, /Show raw/); assert.match(html, /ILS RWY 32R \(SA CAT I\)/);
  const missing = captured('OAK', '7507'), empty = matchPlateNotams([missing], contextFor('OAK', plateFor('OAK', 'SILENT THREE')));
  assert.equal(empty.matches.length, 0); assert.equal(empty.unresolved, 1);
  const fallback = renderToStaticMarkup(createElement(PlateNotamResults, { records: [missing], result: empty, now: NOTAM_NOW }));
  assert.match(fallback, /No established matches/); assert.match(fallback, /Show remaining airport NOTAMs \(1\)/); assert.match(fallback, /SILENT FOUR/);
  for (const [faa, number] of [['DFW', '1931'], ['DTW', '388']]) {
    const r = captured(faa!, number!), parsed = parseNotam(r);
    assert.equal(airport(faa!).procedures.some(p => parsed.targets.some(t => procedureTargetMatch(t.title, parsed.subject, p))), false,
      'unverified SA differences must not become aliases');
  }
});
