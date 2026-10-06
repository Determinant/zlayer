import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotamRecord } from '@zlayer/contracts';
import corpus from './fixtures/notams-corpus.json' with { type: 'json' };
import { notice } from './fixtures/notams';
import { presentNotam } from '../src/layers/notams/presentation';
import { parseNotam } from '../src/layers/notams/parser';
import { approachMinimaGroup } from '../src/layers/notams/minima';
import { takeoffMinimums } from '../src/layers/notams/takeoff';
import { declaredDistances } from '../src/layers/notams/distances';
import { auditNotam, auditRenderedNotam } from '../tools/audit-notams';

const record = (name: string) => corpus.cases.find(entry => entry.name === name)!.record as NotamRecord;
const blocks = (name: string) => presentNotam(record(name)).blocks;

test('captured FAA examples preserve every source span, value, identifier and qualifier', () => {
  for (const entry of corpus.cases) {
    assert.deepEqual(auditNotam(entry.record as NotamRecord), [], entry.name);
    assert.deepEqual(auditRenderedNotam(entry.record as NotamRecord), [], entry.name);
  }
});

test('RDU combined minima keep separate scopes; SEA labeled triplet keeps exact field assignments', () => {
  assert.deepEqual(blocks('mixed-minima')[2], { kind: 'minima-group', entries: [
    { kind: 'minima', scope: 'LNAV/VNAV', rows: [{ categories: 'All categories', values: [{ label: 'DA', value: '709' }, { label: 'HAT', value: '289' }] }] },
    { kind: 'minima', scope: 'LNAV', rows: [{ categories: 'All categories', values: [{ label: 'MDA', value: '800' }, { label: 'HAT', value: '380' }] }] },
  ] });
  assert.deepEqual(blocks('labeled-triplet')[2], { kind: 'minima', scope: 'RNP 0.15', rows: [{
    categories: 'All categories', values: [{ label: 'DA', value: '713' }, { label: 'RVR', value: '2600' }, { label: 'HAT', value: '334' }],
  }] });
  assert.equal(blocks('labeled-triplet').filter(b => b.kind === 'minima').length, 1, 'ALS note numbers never become independent minima');
});

test('BWI unavailable minima remain distinct from numeric or missing values', () => {
  assert.deepEqual(blocks('unavailable-minima')[2], { kind: 'minima-group', entries: [
    { kind: 'minima', scope: 'LPV', rows: [{ values: [{ label: 'DA', value: 'NA' }] }] },
    { kind: 'minima', scope: 'LNAV/VNAV', rows: [{ values: [{ label: 'DA', value: 'NA' }] }] },
  ] });
});

test('ABQ and PDX alternatives retain both branches, including distinct climb requirements', () => {
  assert.deepEqual(blocks('departure-alternatives')[2], { kind: 'takeoff', runway: '3', options: [
    { minimums: '300-1' }, { minimums: 'Standard minimums', climb: { gradient: '245', altitude: '5600' } },
  ] });
  assert.deepEqual(blocks('departure-both-climbs')[2], { kind: 'takeoff', runway: '21', options: [
    { minimums: '300-1', climb: { gradient: '290', altitude: '1800' } },
    { minimums: 'Standard minimums', climb: { gradient: '435', altitude: '4000' } },
  ] });
  assert.deepEqual(blocks('departure-runway-group')[2], { kind: 'takeoff', runway: '4L/R', options: [{ minimums: '300-1' }] });
  assert.deepEqual(blocks('departure-reference').find(b => b.kind === 'takeoff'), { kind: 'takeoff', runway: '15',
    options: [{ minimums: 'Standard minimums', climb: { gradient: '480', altitude: '540' } }], reference: '(2025-ASO-11554-NRA)' });
  assert.equal(blocks('departure-reference').filter(b => b.kind === 'takeoff').length, 1, 'do not borrow a missing takeoff heading for the next runway');
});

test('LIH declared distances keep four separate metrics; missing or unsupported fields are never supplied', () => {
  assert.deepEqual(blocks('declared-distances'), [{ kind: 'distances', runway: '21', values: [
    { label: 'TORA', value: '6000 FT' }, { label: 'TODA', value: '6000 FT' }, { label: 'ASDA', value: '5750 FT' }, { label: 'LDA', value: '5545 FT' },
  ] }]);
  assert.deepEqual(declaredDistances('RWY 21 DECLARED DIST: LDA 5545FT')?.values, [{ label: 'LDA', value: '5545 FT' }]);
  for (const suffix of ['TORA 6000M', 'LDA 5545FT EXC CAT A', 'LDA 5545FT LDA 6000FT']) {
    assert.equal(declaredDistances(`RWY 21 DECLARED DIST: ${suffix}`), undefined);
  }
});

test('RSW, ONT and MSY note actions keep all obstacle, equipment and radial qualifications', () => {
  const rsw = blocks('inoperative-note').find(b => b.kind === 'instruction');
  assert.ok(rsw?.kind === 'instruction'); assert.equal(rsw.label, 'Replace inoperative note');
  assert.match(rsw.text, /S-ILS 6 all categories visibility to RVR 4500, and S-LOC 6 CAT C\/D\/E visibility to 1 3\/8 SM/);
  const ont = blocks('planview-note').find(b => b.kind === 'instruction');
  assert.ok(ont?.kind === 'instruction'); assert.equal(ont.label, 'Change planview note');
  assert.match(ont.text, /PDZ VORTAC airway radials 012 CW 130/i);
  const msy = blocks('obstacle-note').find(b => b.kind === 'instruction');
  assert.ok(msy?.kind === 'instruction'); assert.equal(msy.label, 'Takeoff obstacle notes');
  assert.match(msy.text, /1364FT from DER, 859FT left of centerline, 54 AGL\/49 MSL \(2026-ASW-1914-OE\)/);
});

test('DFW and LAX qualified closures cannot claim unrestricted closure', () => {
  for (const name of ['qualified-taxiway', 'qualified-airport']) {
    const parsed = parseNotam(record(name));
    assert.ok(parsed.facts.some(f => f.label.endsWith('Closure Restriction') && f.tone === 'caution'));
    assert.ok(!parsed.facts.some(f => f.tone === 'danger'));
    assert.match(parsed.facts.find(f => f.label.endsWith('Closure Restriction'))!.evidence.text, /CLSD TO/);
  }
  assert.ok(parseNotam(notice({ text: 'RWY 09L CLSD' })).facts.some(f => f.label === 'Runway Closed' && f.tone === 'danger'));
});

test('ambiguous IAD, EWR, missing-unit and multipart MIA clauses preserve prose instead of supplying meaning', () => {
  assert.ok(blocks('missing-altitude-type').some(b => b.kind === 'text' && /CIRCLING CAT A\/B 960\/HAA 648/i.test(b.text)));
  assert.ok(blocks('radio-altitude').some(b => b.kind === 'text' && b.text.includes('RA 150/14 150 DA 160')));
  assert.equal(blocks('multipart').filter(b => b.kind === 'takeoff').length, 0);
  assert.match(presentNotam(record('multipart')).searchText, /end part 1 of 2\s+part 2 of 2/i);
  for (const name of ['missing-climb-unit']) {
    assert.ok(blocks(name).every(b => b.kind !== 'takeoff'), name);
  }
  assert.ok(blocks('missing-rnp-scope').some(b => b.kind === 'text' && b.text.startsWith('0.25 DA 777/HAT 505')));
});

test('DAL aircraft scopes, MIA staged climbs, APA prohibition and ONT RVR order retain exact associations', () => {
  assert.deepEqual(blocks('aircraft-specific-takeoff').find(b => b.kind === 'takeoff-group'), { kind: 'takeoff-group', entries: [
    { kind: 'takeoff', aircraft: 'Jets', runway: '31L/R', options: [{ minimums: 'Standard minimums' }] },
    { kind: 'takeoff', aircraft: 'Props', runway: '31L/R', options: [{ minimums: 'Standard minimums', climb: { gradient: '235', altitude: '1300' } }] },
  ] });
  assert.deepEqual(blocks('staged-climb').find(b => b.kind === 'takeoff'), { kind: 'takeoff', runway: '8L', options: [
    { minimums: 'Standard minimums', climb: { gradient: '500', altitude: '520' }, then: [{ gradient: '391', altitude: '1700' }] },
  ], reference: '(2025-ASO-25979/25980-OE)' });
  assert.deepEqual(blocks('departure-na-alternative').find(b => b.kind === 'takeoff'), { kind: 'takeoff', runway: '17R', options: [
    { minimums: '300-1' }, { minimums: 'Departure not authorized' },
  ] });
  assert.deepEqual(blocks('unsupported-visibility-order').filter(b => b.kind === 'minima'), [
    ['RNP 0.12','1353','421','4000'],['RNP 0.21','1382','450','4500'],['RNP 0.30','1420','488','5000'],
  ].map(([scope, da, hat, rvr]) => ({ kind: 'minima', scope, rows: [{ categories: 'All categories', values: [
    { label: 'DA', value: da }, { label: 'HAT', value: hat }, { label: 'Visibility', value: `RVR ${rvr}` },
  ] }] })));
});

test('compound grammar is atomic and notes or conditions cannot generate operative values or badges', () => {
  for (const text of ['LNAV MDA 500/HAT 400 ALL CATS, LPV DA NA EXC CAT A.',
    'LNAV MDA 500/HAT 400 ALL CATS, LPV DA NA, NOTE: UNLESS CRANE DOWN.',
    'RNP 0.15 DA/RVR/HAT 713/2600.', 'RNP 0.15 DA/RA/HAT 713/150/334.']) {
    assert.equal(approachMinimaGroup(text), undefined, text);
  }
  for (const text of ['TAKEOFF MINIMUMS: RWY 3, 300-1 OR STANDARD WITH MINIMUM CLIMB OF 245 FT/MIN TO 5600.',
    'TAKEOFF MINIMUMS: RWY 3, STANDARD EXC JETS.', 'TAKEOFF MINIMUMS: RWY 3, STANDARD WITH MINIMUM CLIMB OF 245 TO 5600.']) {
    assert.equal(takeoffMinimums(text), undefined, text);
  }
  for (const prefix of ['IF AUTHORIZED:', 'WHEN ADVISED:', 'DISREGARD NOTE:', 'DELETE', 'NOTE:', 'CHANGE INOP NOTE TO READ:']) {
    const source = notice({ text: `IAP TEST, CA. ILS RWY 09L, AMDT 2... ${prefix} LNAV MDA 600/HAT 400. LPV DA 500/HAT 300. VIS RVR 4000.` });
    assert.ok(presentNotam(source).blocks.every(b => !['minima', 'minima-group'].includes(b.kind)), prefix);
    assert.ok(parseNotam(source).facts.every(f => !['Minima Amended', 'Visibility Amended'].includes(f.label)), prefix);
  }
});

test('audit catches dropped clauses, values, identifiers and qualifiers independently of grammar', () => {
  const source = notice({ text: 'TWY F CLSD TO ACFT WINGSPAN MORE THAN 118FT. EXC EMERG ACFT.' });
  const presentation = presentNotam(source);
  for (const text of ['TWY F CLSD.', 'TWY F CLSD TO ACFT WINGSPAN MORE THAN 128FT.', 'TWY B CLSD TO ACFT WINGSPAN MORE THAN 118FT.']) {
    assert.ok(auditNotam(source, { ...presentation, blocks: [{ kind: 'text', text }, presentation.blocks[1]!] }).length);
  }
  assert.ok(auditNotam(source, { ...presentation, blocks: presentation.blocks.slice(0, 1), sourceSpans: presentation.sourceSpans.slice(0, 1) }).length);
});
