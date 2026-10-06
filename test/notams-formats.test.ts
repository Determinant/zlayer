import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotamRecord } from '@zlayer/contracts';
import corpus from './fixtures/notams-formats.json' with { type: 'json' };
import { notice, testProcedure } from './fixtures/notams';
import { parseNotam } from '../src/layers/notams/parser';
import { presentNotam, type NotamBodyBlock } from '../src/layers/notams/presentation';
import { approachMinimaGroup } from '../src/layers/notams/minima';
import { takeoffMinimums } from '../src/layers/notams/takeoff';
import { qualifiedFdcLocalText } from '../src/layers/notams/source-text';
import { notamDisplayText } from '../src/layers/notams/readable-text';
import { notamObstacles } from '../src/layers/notams/obstacles';
import { notamValidity } from '../src/layers/notams/validity';
import { isApproachTitle } from '../src/layers/notams/procedure-title';
import { matchPlateNotams } from '../src/layers/notams/matcher';
import { notamContentDifferences } from '../tools/info-server/notams/revision';
import { auditNotam, auditMappedNotam, auditRenderedNotam } from '../tools/audit-notams';
import { auditValueBindings } from '../tools/notam-value-audit';

const record = (name: string) => corpus.cases.find(entry => entry.name === name)!.record as NotamRecord;
const blocks = (name: string) => presentNotam(record(name)).blocks;
const minima = (name: string) => blocks(name).flatMap(b => b.kind === 'minima-group' ? b.entries : b.kind === 'minima' ? [b] : []);
const values = (name: string) => minima(name).map(b => [b.scope, ...b.rows.map(r => [r.categories ?? null, ...r.values.map(v => [v.label, v.value])])]);

test('1,000-airport regression samples preserve raw records, evidence, values and both reader paths', () => {
  for (const { name, record: raw } of corpus.cases) {
    const source = raw as NotamRecord, original = JSON.stringify(source), parsed = parseNotam(source);
    for (const derived of [...parsed.targets, ...parsed.facts]) {
      const { start, end, text } = derived.evidence;
      assert.equal(parsed.body.slice(start, end), text, name);
    }
    assert.deepEqual(auditNotam(source), [], name);
    assert.deepEqual(auditRenderedNotam(source), [], name);
    assert.deepEqual(auditMappedNotam(source), [], name);
    assert.deepEqual(auditRenderedNotam(source, true), [], name);
    assert.equal(JSON.stringify(source), original, name);
  }
});

test('publisher heading variants keep the complete written procedure identity', () => {
  const expected: Record<string, string[]> = {
    'rnav-departure': ['PADRZ TWO'], 'rnav-arrival': ['DOOBI THREE'],
    'arrival-abbreviation': ['GILCO FIVE'], 'wrapped-arrival': ['GTOUT ONE'],
    'arrival-prohibited': ['SHLAE ONE'], 'newline-airport-heading': ['PETTE TWO'], 'prm-approach': ['RNAV (GPS) PRM RWY 9R'],
    'category-approach': ['ILS OR LOC RWY 9L', 'ILS RWY 9L SA CAT I', 'ILS RWY 9L CAT II/III'],
    'sat-category-approach': ['ILS OR LOC RWY 12', 'ILS RWY 12 (SAT CAT I)'],
    'copter-bearing': ['COPTER RNAV (GPS) 027'], 'converging-approach': ['ILS V RWY 17 (CONVERGING)'],
    'letter-variant': ['RNAV (GPS) M RWY 17L'], 'tacan-vor': ['HI - TACAN OR VOR-B'],
    'permanent-arrival': ['SARDI ONE'], 'permanent-approach': ['RNAV (GPS) Z  RWY 8'],
  };
  for (const [name, titles] of Object.entries(expected)) {
    assert.deepEqual(parseNotam(record(name)).targets.map(t => t.title), titles, name);
    assert.equal(parseNotam(record(name)).unresolved, false, name);
  }
  assert.equal(parseNotam(record('permanent-approach')).targets[0]!.amendment, 'ORIG-B', 'later THIS IS wording cannot replace the affected amendment');
  for (const title of ['UNSUPPORTED RNAV (GPS) RWY 09', 'ILS RWY 09 (SAT CAT II)', 'RNAV (GPS) RWY 39']) {
    const parsed = parseNotam(notice({ text: `IAP TEST, CA. ${title}, AMDT 1... LNAV MDA 600/HAT 300.` }));
    assert.equal(parsed.targets.length, 0, title); assert.equal(parsed.unresolved, true, title);
  }
});

test('KOAK 6/6268 matches the published SA CAT I amendment without changing the source heading', () => {
  const source = record('sat-category-approach'), before = JSON.stringify(source);
  const context = (name: string, amendmentNumber = '8B') => ({ status: 'resolved' as const,
    airport: { faaId: 'OAK', icaoId: 'KOAK' }, key: 'test', cycle: '2610',
    effectiveDate: '2026-10-01', expirationDate: '2026-10-29',
    procedure: { ...testProcedure, name, source: { ...testProcedure.source, amendmentNumber } } });
  for (const title of ['ILS OR LOC RWY 12', 'ILS RWY 12 (SA CAT I)']) {
    const result = matchPlateNotams([source], context(title));
    assert.equal(result.matches[0]?.outcome, 'applies', title);
    assert.equal(result.unresolved, 0);
  }
  for (const title of ['ILS RWY 12 (SA CAT II)', 'ILS RWY 12 (CAT I)', 'ILS RWY 30 (SA CAT I)', 'ILS RWY 12R (SA CAT I)']) {
    assert.equal(matchPlateNotams([source], context(title)).matches.length, 0, title);
  }
  assert.equal(matchPlateNotams([source], context('ILS RWY 12 (SA CAT I)', '8C')).matches[0]?.outcome, 'review');
  const target = parseNotam(source).targets[1]!;
  assert.equal(target.title, 'ILS RWY 12 (SAT CAT I)');
  assert.equal(source.text.slice(target.evidence.start, target.evidence.end), target.title);
  assert.ok(presentNotam(source).searchText.includes(target.title));
  assert.equal(JSON.stringify(source), before);
});

test('amendment fallback cannot promote a later quoted or conditional title into an affected procedure', () => {
  for (const subject of ['SID', 'STAR']) {
    for (const boundary of ['DISREGARD NOTE:', 'IF AUTHORIZED:', 'PART 1 OF 2', 'FOR INOPERATIVE EQUIPMENT:']) {
      const source = notice({ text: `${subject} TEST AIRPORT, CA.\nALPHA ONE, AMDT 1...\n${boundary}\nBRAVO TWO, AMDT 2...` });
      assert.deepEqual(parseNotam(source).targets.map(t => t.title), ['ALPHA ONE'], `${subject}: ${boundary}`);
    }
  }
});

test('FDC subject recovery and collection equivalence require the entire body, identity and interval', () => {
  for (const [name, subject] of [['permanent-arrival', 'STAR'], ['permanent-approach', 'IAP'],
    ['route-subject', 'ROUTE'], ['visual-subject', 'VFP'], ['special-subject', 'SPECIAL']]) {
    const source = record(name!);
    assert.ok(qualifiedFdcLocalText(source), name);
    assert.equal(parseNotam(source).subject, subject, name);
    const prefixed = { ...source, text: `${subject} ${source.text}` };
    assert.deepEqual(notamContentDifferences(source, prefixed), [], name);
    for (const change of [{ number: '9999' }, { year: '1999' }, { locations: ['TST'] }, { classification: 'DOMESTIC' },
      { series: 'A' }, { startsAt: source.startsAt! + 60_000 }, { text: source.text + ' EXC JETS' },
      { translations: [...source.translations, { type: 'LOCAL_FORMAT', text: 'A conflicting rendering' }] }]) {
      assert.equal(qualifiedFdcLocalText({ ...source, ...change }), undefined, `${name}: ${JSON.stringify(change)}`);
    }
  }
  const permanent = record('permanent-arrival');
  for (const change of [{ endsAt: permanent.startsAt }, { effectiveEnd: 'UNKNOWN' }, { endKind: 'unknown' as const }]) {
    assert.equal(qualifiedFdcLocalText({ ...permanent, ...change }), undefined);
  }
});

test('title states consume every qualifier and reject incomplete or invented compound identities', () => {
  for (const title of ['HI-ILS Z OR LOC Z RWY 09L', 'ILS PRM RWY 18L (CLOSE PARALLEL)',
    'RNAV (RNP) W RWY 04L', 'CONVERGING ILS RWY 19', 'ILS RWY 12L (SA CAT I) (CAT II-III)',
    'ILS RWY 09 (SAT CAT I)', 'ILS RWY 09 SA CAT 1', 'ILS RWY 09 (CAT 2 & 3)',
    'COPTER RNAV (GPS) M 172', 'LOC BC RWY 27', 'VOR/DME OR TACAN-A', 'RADAR-1']) {
    assert.equal(isApproachTitle(title), true, title);
    const parsed = parseNotam(notice({ text: `IAP TEST, CA. ${title}, AMDT 1... PROCEDURE NA.` }));
    assert.deepEqual(parsed.targets.map(t => t.title), [title], title);
  }
  for (const title of ['SPECIAL ILS RWY 09', 'ILS OR RNAV RWY 09', 'RNAV (GPS OR RNP) RWY 09',
    'ILS RWY 09 (CAT I', 'ILS RWY 09 CAT IV', 'ILS RWY 09 (SAT CAT II)', 'ILS RWY 09 CAT I EXC JETS',
    'RNAV (GPS) RWY 09 (SAT CAT I)', 'ILS RWY 09 (SAT CAT I-II)', 'ILS RWY 09 (CAT 4)', 'ILS RWY 09 (CAT III-II)',
    'VOR/DME RWY 00', 'RNAV (GPS) RWY 037', 'COPTER RNAV (RNP) 172', 'ILS RWY 09/LAND',
    'ILS RWY 09 (CAT I) UNKNOWN', 'ILS RWY 09 OR LOC RWY 18']) {
    assert.equal(isApproachTitle(title), false, title);
  }
});

test('ILS components and monitoring states never imply a different facility dependency', () => {
  const expected = [
    ['glideslope-outage', 'GP', '9', 'unavailable'], ['localizer-outage', 'LOC', '32', 'unavailable'],
    ['combined-components', 'LOC/GP', '16R', 'unavailable'], ['outer-marker', 'ILS OM', '14', 'unavailable'],
    ['ils-dme', 'ILS DME', '4', 'unavailable'], ['unmonitored-ils', 'ILS', '31', 'unmonitored'],
  ];
  for (const [name, facility, runway, effect] of expected) {
    assert.deepEqual(parseNotam(record(name!)).facilityTarget, { facility, runway, effect }, name);
  }
  const context = (name: string) => ({ status: 'resolved' as const, airport: { faaId: 'TST', icaoId: 'KTST' },
    procedure: { ...testProcedure, name }, key: 'test', cycle: '2610', effectiveDate: '2026-10-01', expirationDate: '2026-10-29' });
  const source = (text: string) => notice({ text });
  const gp = source('NAV ILS RWY 09L GP U/S');
  assert.equal(matchPlateNotams([gp], context('ILS RWY 09L')).matches[0]?.outcome, 'applies');
  assert.equal(matchPlateNotams([gp], context('LOC RWY 09L')).matches.length, 0);
  const marker = source('NAV ILS RWY 09L OM U/S');
  assert.equal(matchPlateNotams([marker], context('ILS RWY 09L')).matches[0]?.outcome, 'review');
  assert.ok(!parseNotam(marker).facts.some(f => f.label === 'ILS Unavailable'));
  const unmonitored = matchPlateNotams([source('NAV ILS RWY 09L NOT MNT')], context('ILS RWY 09L'));
  assert.match(unmonitored.matches[0]!.reason, /monitoring restriction/);
  for (const text of ['NAV VOR RWY 09L GP U/S', 'NAV ILS RWY 09L NOT U/S']) {
    assert.equal(parseNotam(source(text)).facilityTarget, undefined, text);
  }
});

test('surface and service effects preserve segment boundaries and cross-sentence exceptions', () => {
  for (const name of ['runway-endpoints', 'taxilane-endpoint', 'ramp-endpoint']) {
    assert.ok(parseNotam(record(name)).facts.some(f => f.label === 'Taxiway Closed'), name);
  }
  const partial = parseNotam(record('partial-runway'));
  assert.ok(partial.facts.some(f => f.label === 'Runway Segment Closed'));
  assert.ok(!partial.facts.some(f => f.label === 'Runway Closed'));
  const qualified = parseNotam(record('qualified-closure'));
  assert.ok(!qualified.facts.some(f => f.tone === 'danger'));
  assert.match(qualified.facts.find(f => f.label === 'Taxiway Closure Restriction')!.evidence.text, /SMALL HELICOPTERS ONLY/);
  for (const [name, label] of [['atis-outage', 'ATIS Unavailable'], ['tower-closure', 'Tower Closed'],
    ['qualified-service', 'PCL ALL Restriction'], ['pointer', 'See NOTAM PXR 01/005']]) {
    assert.ok(parseNotam(record(name!)).facts.some(f => f.label === label), name);
  }
  for (const text of ['TWY A BTN TWY B AND NOT CLOSED RAMP CLSD', 'COM ATIS NOT U/S', 'NOTE: TWY A CLSD']) {
    assert.ok(!parseNotam(notice({ text })).facts.some(f => /Closed|Unavailable/.test(f.label)), text);
  }
});

test('explicit fields preserve altitude type, units, category scope and field order', () => {
  assert.deepEqual(values('paired-altitudes'), [['Circling', ['CAT A', ['MDA', '680'], ['HAA', '467']]]]);
  assert.deepEqual(values('category-and'), [['Circling', ['CAT C AND D', ['MDA', '1480'], ['HAA', '801']]]]);
  assert.deepEqual(values('explicit-units'), [
    ['RNP 0.15', [null, ['DA', '396FT'], ['HAT', '388FT']], ['All categories', ['Visibility', '1-1/8SM']]],
    ['RNP 0.30', [null, ['DA', '465FT'], ['HAT', '457FT']], ['All categories', ['Visibility', '1-3/8SM']]],
  ]);
  assert.deepEqual(values('adjacent-fields'), [['LPV', [null, ['DA', '712'], ['HAT', '378'], ['Visibility', '1 SM']]]]);
  assert.deepEqual(values('slash-fields'), [['Circling', ['CAT D', ['MDA', '6900'], ['HAA', '1015'], ['Visibility', '3']]]]);
  assert.deepEqual(values('colon-label'), [['RNP 0.30', ['All categories', ['DA', '1697'], ['HAT', '383']]]]);
  assert.deepEqual(values('minimums-na'), ['LPV', 'LNAV/VNAV'].map(scope => [scope, ['All categories', ['Minimums', 'NA']]]));
  assert.deepEqual(values('newline-minima'), [
    ['LNAV/VNAV', [null, ['DA', '474'], ['HAT', '358']], ['All categories', ['RVR', '3000']]],
    ['LNAV', ['All categories', ['MDA', '580'], ['HAT', '464']], ['CAT C/D', ['RVR', '5000']]],
  ]);
  assert.deepEqual(values('adjacent-rvr'), [
    ['RNP 0.11', [null, ['DA', '4835'], ['HAT', '373']]],
    ['RNP 0.30', [null, ['DA', '4907'], ['HAT', '443'], ['RVR', '4500']]],
  ]);
  assert.equal(minima('semicolon-minima').length, 3);
  assert.deepEqual(values('bare-ils'), [['ILS', ['All categories', ['DA', '534'], ['HAT', '250']]]]);
  assert.deepEqual(values('conditional-rvr'), [['S-ILS 25L CAT II', [null, ['RVR', '1200']]]]);
  assert.ok(blocks('conditional-rvr').some(b => b.kind === 'instruction' && /1000.*SPECIFIC OPSPEC/i.test(b.text)));
});

test('numeric extensions stay atomic and independent audit rejects swapped units, scopes and fields', () => {
  const marked = approachMinimaGroup('LPV DA # 5614/HAT 365.')!;
  assert.equal(marked.kind, 'minima');
  if (marked.kind === 'minima') assert.deepEqual(marked.rows[0]!.values, [{ label: 'DA#', value: '5614' }, { label: 'HAT', value: '365' }]);
  assert.deepEqual(auditValueBindings('LPV DA # 5614/HAT 365.', marked), []);
  for (const text of ['LNAV CAT A 600/HAA 400', 'LNAV DA/HAT 600/400/200', 'LNAV VIS 500FT', 'LNAV DA 1/2 SM',
    'LPV DA 500/HAT 300/VIS 1 EXC CAT A', 'LPV DA 500/300 VIS 1', 'LPV CAT A DA 500 CAT B',
    'LPV DA 500 HAT CAT A 300', 'LPV DA NA/HAT 300',
    'LPV DA 500; LNAV 600/HAT 300', 'LPV DA 500; DELETE LNAV MDA 600/HAT 300']) {
    assert.equal(approachMinimaGroup(text), undefined, text);
  }
  const source = 'LPV DA 500FT/HAT 300FT/VIS 1SM ALL CATS';
  const valid = approachMinimaGroup(source)!;
  assert.equal(valid.kind, 'minima'); if (valid.kind !== 'minima') return;
  assert.deepEqual(auditValueBindings(source, valid), []);
  const mutations: NotamBodyBlock[] = [
    { ...valid, scope: 'LNAV' },
    { ...valid, rows: [{ ...valid.rows[0]!, categories: 'CAT A' }] },
    { ...valid, rows: [{ ...valid.rows[0]!, values: [{ label: 'HAT', value: '500FT' }, { label: 'DA', value: '300FT' }, { label: 'Visibility', value: '1SM' }] }] },
    { ...valid, rows: [{ ...valid.rows[0]!, values: [{ label: 'DA', value: '500' }, { label: 'HAT', value: '300FT' }, { label: 'Visibility', value: '1SM' }] }] },
  ];
  for (const changed of mutations) assert.ok(auditValueBindings(source, changed).length);
});

test('document states cannot reset a note, condition or multipart envelope at punctuation', () => {
  for (const prefix of ['NOTE FOR CAT II:', 'MISSED APPROACH:', 'FOR INOPERATIVE ALS,', 'PART 1 OF 2', 'WHEN AUTHORIZED:']) {
    const source = notice({ text: `IAP TEST, CA. ILS RWY 09, AMDT 1... ${prefix} READ THE FULL SOURCE. LPV DA 500/HAT 300. VIS RVR 4000.` });
    assert.ok(presentNotam(source).blocks.every(b => !['minima', 'minima-group'].includes(b.kind)), prefix);
    assert.ok(!parseNotam(source).facts.some(f => ['Minima Amended', 'Visibility Amended'].includes(f.label)), prefix);
    assert.deepEqual(auditNotam(source), [], prefix);
  }
});

test('short climb stages retain gradient units and stage order; absent labels remain prose', () => {
  const takeoff = blocks('short-climb-stage').find(b => b.kind === 'takeoff');
  assert.deepEqual(takeoff, { kind: 'takeoff', runway: '03', options: [{ minimums: 'Standard minimums',
    climb: { gradient: '500', altitude: '680' }, then: [{ gradient: '280', altitude: '6300' }] }] });
  for (const suffix of ['THEN 280 TO 6300', 'THEN 280 FT/MIN TO 6300', 'THEN 280 FT/NM TO 6300 EXC JETS']) {
    assert.equal(takeoffMinimums(`TAKEOFF MINIMUMS: RWY 03: STANDARD WITH MINIMUM CLIMB OF 500 FT/NM TO 680, ${suffix}.`), undefined);
  }
  assert.ok(blocks('missing-altitude-label').some(b => b.kind === 'text' && /CAT A 6540\/HAA 655/.test(b.text)));
  assert.ok(minima('missing-altitude-label').every(b => b.scope !== 'Circling'));
  assert.ok(blocks('missing-climb-unit').every(b => b.kind !== 'takeoff'));
  assert.equal(parseNotam(record('multipart')).unresolved, true);
});

test('source character escapes and runway-relative annotations do not manufacture source facts', () => {
  const escaped = record('escaped-airport');
  assert.ok(presentNotam(escaped).searchText.includes("O'Hare"));
  assert.ok(escaped.text.includes('&apos;'));
  assert.equal(notamDisplayText('&amp;apos; &lt;script&gt; &quot;Q&quot;'), '&apos; &lt;script&gt; "Q"', 'decode once, plain text only');
  assert.equal(notamObstacles(record('runway-offset-obstacle')).length, 1);
  assert.equal(notamObstacles(record('invalid-coordinate')).length, 0);
  assert.equal(notamObstacles(record('unknown-msl')).length, 0);
  assert.equal(notamValidity(record('conflicting-schedule'), Date.parse(corpus.capturedAt)), 'check schedule');
});
