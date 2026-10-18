import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotamRecord } from '@zlayer/contracts';
import captured from './fixtures/notams-interpretation-2026-10-15.json' with { type: 'json' };
import { notice, testProcedure } from './fixtures/notams';
import { parseNotam } from '../src/layers/notams/parser';
import { navigationNotice } from '../src/layers/notams/navigation-notice';
import { matchPlateNotams } from '../src/layers/notams/matcher';
import { presentNotam } from '../src/layers/notams/presentation';
import { notamObstacles } from '../src/layers/notams/obstacles';
import { notamClauses } from '../src/layers/notams/clauses';
import { auditNotam, auditMappedNotam, auditRenderedNotam } from '../tools/audit-notams';
import { auditValueBindings, auditNavigationBindings } from '../tools/notam-value-audit';

const record = (id: string) => captured.cases.find(c => c.record.id === id)!.record as NotamRecord;

test('captured navigation, military, transport and numeric variants retain all source and reader evidence', () => {
  for (const { airport, record: raw } of captured.cases) {
    const r = raw as NotamRecord, before = JSON.stringify(r), context = `${airport}/${r.id}`;
    assert.deepEqual(auditNotam(r), [], context);
    assert.deepEqual(auditMappedNotam(r), [], context);
    assert.deepEqual(auditRenderedNotam(r), [], context);
    assert.deepEqual(auditRenderedNotam(r, true), [], context);
    assert.equal(JSON.stringify(r), before, context);
    const parsed = parseNotam(r);
    for (const f of [...parsed.facts, ...parsed.targets]) assert.equal(parsed.body.slice(f.evidence.start, f.evidence.end), f.evidence.text, context);
    if (parsed.navigation) assert.equal(parsed.body.slice(parsed.navigation.evidence.start, parsed.navigation.evidence.end), parsed.navigation.evidence.text, context);
  }
});

test('navigation component and effect states retain exact source identities and qualified coverage', () => {
  for (const [id, expected] of [
    ['1770671118049947', { facility: 'TACAN', components: ['AZM'], effect: 'unavailable' }],
    ['1791996183294731', { facility: 'ILS', runway: '15', components: ['LOC', 'GP', 'DME'], effect: 'unavailable' }],
    ['1791916021857061', { facility: 'ILS', runway: '30R', components: ['GP', 'LOC'], effect: 'unmonitored' }],
    ['1791916091916533', { facility: 'ILS', runway: '12L', components: ['LOC', 'GP', 'IM'], effect: 'unmonitored' }],
    ['1791287472433058', { facility: 'ILS', runway: '08L', components: ['LOM'], locator: 'EWABE', effect: 'unavailable' }],
    ['1792004756547037', { facility: 'LDA', runway: '26L', components: [], effect: 'unavailable' }],
    ['1792008590662540', { facility: 'ILS', runway: '18', components: [], effect: 'restricted', qualification: 'DA TO TDZ' }],
    ['1788350552009813', { facility: 'VOR', components: [], effect: 'restricted', qualification: '220-265' }],
    ['1790714607999475', { facility: 'VOR', components: [], effect: 'unavailable', qualification: 'GND REC CHECKPOINT' }],
    ['3685772689350537', { facility: 'VOR', components: [], effect: 'unavailable', qualification: 'GND REC CHECKPOINT FOR TWY A1' }],
    ['1776344476384328', { facility: 'LOC', runway: '12', components: ['BC'], effect: 'restricted', qualification: 'BEYOND 15DEG LEFT OF COURSE' }],
    ['1775780692707005', { facility: 'NDB', sourceReference: 'RYN', station: 'RBJ', components: [], effect: 'unavailable' }],
    ['1786125152224176', { facility: 'LOM', sourceReference: 'JAX', station: 'DINNS', components: [], effect: 'unavailable' }],
  ] as const) {
    const parsed = parseNotam(record(id));
    assert.equal(parsed.subject, 'NAV', id);
    assert.ok(parsed.navigation, id);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(parsed.navigation[key as keyof typeof parsed.navigation], value, `${id}/${key}`);
  }
});

test('a complete navigation clause cannot acquire a different station, component, runway or effect', () => {
  const input = (text: string) => navigationNotice(text, { locations: ['TST'], icaoLocations: ['KTST'] });
  for (const text of ['NAV ILS RWY 09 NOT U/S', 'NAV VOR RWY 09 GP U/S', 'NAV TACAN OM U/S',
    'NAV VOR OUTER MARKER U/S', 'NAV ILS RWY 39 U/S', 'NAV ILS RWY 09 LOC/UNKNOWN U/S',
    'ZZZ NAV DEF ILS RWY 09 U/S',
    'NAV ILS RWY 09 LOC/LOC U/S', 'NAV ILS RWY 09 MAY BE U/S', 'DELETE NAV ILS RWY 09 U/S',
    'NAV VOR 400-450 UNUSABLE', 'NAV ILS RWY 09 U/S. DISREGARD THIS NOTICE',
    'NAV ILS RWY 09 UNKNOWN U/S', 'NAV ILS RWY 09 U/S FREQ 110.3']) assert.equal(input(text), undefined, text);
  for (const [text, expected] of [
    ['NAV RWY 09 ILS U/S', { facility: 'ILS', runway: '09', effect: 'unavailable' }],
    ['NAV ILS RWY 10R(Z) IM NOT MNT.', { facility: 'ILS', runway: '10R', variant: 'Z', components: ['IM'], effect: 'unmonitored' }],
    ['NAV TST NAV DME DECOMMISSIONED', { facility: 'DME', station: 'TST', effect: 'decommissioned' }],
    ['TST ILS RWY 09 LOC/GP/DME U/S', { facility: 'ILS', sourceReference: 'TST', components: ['LOC', 'GP', 'DME'], effect: 'unavailable' }],
    ['/ABC/ NAV TACAN AZM 065-069 BEYOND 18NM UNUSABLE', { facility: 'TACAN', sourceReference: 'ABC', components: ['AZM'], effect: 'restricted', qualification: '065-069 BEYOND 18NM' }],
  ] as const) for (const [key, value] of Object.entries(expected)) assert.deepEqual(input(text)![key as keyof NonNullable<ReturnType<typeof input>>], value, text);
});

test('RVR sensor outages retain their airport/runway and sensor scope without implying runway closure', () => {
  for (const [id, label, scope] of [
    ['1792015092056797', 'All RVR Unavailable', undefined],
    ['1791802361730448', 'RVR Unavailable', 'RWY 26'],
    ['1791968869086165', 'RVRT Unavailable', 'RWY 09'],
    ['1777892593032881', 'RVRM Unavailable', 'RWY 23R'],
    ['1791968762447597', 'RVRR Unavailable', 'RWY 27'],
  ]) {
    const r = record(id!), parsed = parseNotam(r);
    const fact = parsed.facts.find(f => f.kind === 'outage');
    assert.equal(fact?.label, label, id); assert.equal(fact?.scope, scope, id);
    assert.ok(!parsed.facts.some(f => f.kind === 'closure'), id);
    assert.deepEqual(auditNotam(r), [], id);
  }
  for (const text of ['RWY 09 RVR NOT U/S', 'RWY 09 RVR U/S EXC TOUCHDOWN',
    'AD AP RVR ALL U/S WHEN TOWER CLOSED', 'DELETE NOTE: RWY 09 RVR U/S',
    'RWY 09 RVR U/S. ONLY DURING MAINTENANCE', 'RWY 39 RVR U/S',
    'RWY 09 RVR UNKNOWN U/S', 'RWY 09 RVR 4000 U/S']) {
    assert.ok(!parseNotam(notice({ text })).facts.some(f => f.kind === 'outage'), text);
  }
});

test('independent navigation audit rejects equal-word component, runway, locator and effect corruption', () => {
  const source = 'NAV ILS RWY 09L LOC/GP/DME U/S';
  const parsed = parseNotam(notice({ text: source })).navigation!;
  assert.deepEqual(auditNavigationBindings(source, parsed), []);
  for (const changes of [{ components: ['GP', 'LOC', 'DME'] }, { components: ['LOC'] }, { runway: '09R' },
    { effect: 'unmonitored' as const }, { sourceEffect: 'NOT MNT' as const }, { qualification: 'DA TO TDZ' }]) {
    assert.ok(auditNavigationBindings(source, { ...parsed, ...changes }).length, JSON.stringify(changes));
  }
  const locator = parseNotam(record('1791287472433058')).navigation!;
  assert.ok(auditNavigationBindings(locator.evidence.text, { ...locator, locator: 'OTHER' }).length);
  const wrapped = parseNotam(record('1775780692707005')).navigation!;
  for (const changes of [{ station: 'RYN' }, { sourceReference: 'RBJ' }]) {
    assert.ok(auditNavigationBindings(wrapped.evidence.text, { ...wrapped, ...changes }).length, JSON.stringify(changes));
  }
  for (const field of ['station', 'sourceReference'] as const) {
    const omitted = { ...wrapped }; delete omitted[field];
    assert.ok(auditNavigationBindings(wrapped.evidence.text, omitted).length, field);
  }
  const airport = parseNotam(record('1786125152224176')).navigation!;
  assert.ok(auditNavigationBindings(airport.evidence.text, { ...airport, station: 'JAX' }, ['JAX', 'KJAX']).length);
});

test('combined components prove only their own plate dependencies, while qualified and marker effects require review', () => {
  const context = (name: string) => ({ status: 'resolved' as const, airport: { faaId: 'TST', icaoId: 'KTST' },
    procedure: { ...testProcedure, name }, key: 'test', cycle: '2610', effectiveDate: '2026-10-01', expirationDate: '2026-10-29' });
  const group = notice({ text: 'NAV ILS RWY 09L LOC/GP/DME U/S' });
  for (const name of ['ILS RWY 09L', 'LOC RWY 09L']) assert.equal(matchPlateNotams([group], context(name)).matches[0]?.outcome, 'applies', name);
  for (const name of ['RNAV (GPS) RWY 09L', 'ILS RWY 09R']) assert.equal(matchPlateNotams([group], context(name)).matches.length, 0, name);
  const marker = notice({ text: 'NAV ILS RWY 09L IM U/S' });
  assert.equal(matchPlateNotams([marker], context('ILS RWY 09L')).matches[0]?.outcome, 'review');
  const qualified = notice({ text: 'NAV ILS RWY 09L UNUSABLE DA TO TDZ' });
  assert.equal(matchPlateNotams([qualified], context('ILS RWY 09L')).matches[0]?.outcome, 'review');
  assert.equal(matchPlateNotams([qualified], context('RNAV (GPS) RWY 09L')).matches.length, 0);
  assert.ok(!parseNotam(qualified).facts.some(f => f.label === 'ILS Unavailable'));
  const variant = notice({ text: 'NAV ILS RWY 09L(Z) LOC U/S' });
  assert.equal(matchPlateNotams([variant], context('ILS Z RWY 09L')).matches[0]?.outcome, 'applies');
  assert.equal(matchPlateNotams([variant], context('ILS Y RWY 09L')).matches.length, 0);
  assert.equal(matchPlateNotams([variant], context('ILS RWY 09L')).matches[0]?.outcome, 'review');
  assert.equal(matchPlateNotams([variant], context('ILS OR LOC Z RWY 09L')).matches[0]?.outcome, 'review');
  const conditionalMonitoring = parseNotam(notice({ text: 'NAV ILS RWY 09L NOT MNT WHEN TOWER CLOSED' }));
  assert.equal(conditionalMonitoring.navigation?.sourceEffect, 'NOT MNT');
  assert.equal(conditionalMonitoring.navigation?.effect, 'restricted');
  assert.equal(conditionalMonitoring.facilityTarget?.effect, 'unmonitored');
});

test('bound Q subjects and military operating envelopes preserve restrictions without claiming airport closure', () => {
  const ramp = record('8423922599903609');
  const parsed = parseNotam(ramp);
  assert.equal(parsed.subject, 'APRON'); assert.deepEqual(parsed.subjectBasis, { kind: 'icao-code', code: 'QMNLC' });
  assert.ok(parsed.facts.some(f => f.label === 'Ramp Closed'));
  for (const changes of [{ number: '9999' }, { startsAt: ramp.startsAt! + 60_000 },
    { text: ramp.text + ' EXC JETS' }, { icaoLocations: ['KXXX'] },
    { translations: [...ramp.translations, { type: 'OTHER:ICAO', text: ramp.translations[1]!.text.replace('QMNLC', 'QMRLC') }] }]) {
    assert.notEqual(parseNotam({ ...ramp, ...changes }).subjectBasis?.kind, 'icao-code');
  }
  for (const [id, subject, label] of [
    ['4168330480630982', 'APRON', 'Parking Restriction'], ['5571766776706562', 'AD', 'Operating Hours'],
    ['9876753417127340', 'SVC', 'ARFF Restriction'], ['6435955292157013', 'OBST', 'Obstacle Light Outage'],
    ['7771675723861585', 'TWY', 'Obstacle Light Outage'],
  ]) {
    const parsed = parseNotam(record(id!)); assert.equal(parsed.subject, subject, id);
    assert.ok(parsed.facts.some(f => f.label === label), `${id}/${label}`);
    assert.ok(!parsed.facts.some(f => f.label === 'Airport Closed'), id);
  }
  assert.equal(parseNotam(record('7380882786071034')).subject, 'RWY');
  assert.equal(parseNotam({ ...record('7380882786071034'), locations: ['WRONG'] }).subject, undefined);
});

test('surface closures require affirmative primary wording and retain conditions and partial scope', () => {
  const closures = (text: string) => parseNotam(notice({ text })).facts.filter(f => ['closure', 'closure-restriction'].includes(f.kind));
  for (const surface of ['RED RAMP', 'SOUTH RAMP', 'MIL TXL A', 'APRON SOUTH RAMP', 'TWY A']) {
    for (const status of ['NOT CLSD.', 'NOT CLOSED.', 'NEVER CLSD.', 'CANNOT BE CLSD.', 'EXPECTED CLSD.', 'WILL NOT BE CLOSED.', 'MAY BE CLSD.', 'WAS CLOSED.',
      'NOTE: CLSD.', 'WHEN CLSD USE CAUTION.', 'READS "CLSD".', 'OPEN. RWY 09 CLSD.']) {
      const text = `${surface} ${status}`;
      assert.deepEqual(closures(text), [], text);
      assert.match(presentNotam(notice({ text })).searchText, /clsd|closed/i, 'source wording remains inspectable');
    }
  }
  for (const text of ['RED RAMP CLSD.', 'MIL TXL A CLOSED.', 'SPOT A CLSD.']) {
    assert.equal(closures(text)[0]?.kind, 'closure', text);
  }
  for (const text of ['RED RAMP CLSD TO JETS.', 'SPOT A CLOSED EXCEPT HELICOPTERS.',
    'RED RAMP CLSD WHEN TOWER CLOSED.', 'RED RAMP CLSD. SMALL HELICOPTERS ONLY.',
    'HICKAM AIR FORCE BASE RAMP SPOT 4D CLSD.', 'SVC TWR CLSD EXC EMERG.', 'APRON SOUTH RAMP CLSD IF WET.',
    'PETERSON AIR FORCE BASE RAMP APRON PARKING ROWS, INDIA, JULIET, AND KILO CLOSED TO ALL AIRCRAFT DUE TO CONSTRUCTION.',
    'PETERSON AIR FORCE BASE RAMP ALL PARKING SPOTS IN THE HEAVY AREA, INDIA ROW, AND JULIET ROW CLOSED TO FIGHTER TYPE AIRCRAFT',
    'PETERSON AIR FORCE BASE RAMP 302 RESTRICTED AREA PARKING SPOT V-1 CLOSED TO FIGHTER TYPE AIRCRAFT',
    'HICKAM AIR FORCE BASE RAMP A PORTION OF TAXIWAY HA FROM 15 ROW TO 11 ROW CLSD.']) {
    const facts = closures(text);
    assert.equal(facts.length, 1, text); assert.equal(facts[0]!.kind, 'closure-restriction', text);
    assert.equal(facts[0]!.tone, 'caution', text); assert.doesNotMatch(facts[0]!.label, /Closed$/, text);
    assert.equal(facts[0]!.evidence.text, text, 'retain the complete qualification');
  }
  for (const text of ['RED RAMP CLSD IS INCORRECT.', 'RED RAMP "CLSD".', 'RED RAMP CLSD. DISREGARD THIS NOTICE.',
    'RED RAMP CONST IN CLSD PVMT.', 'RED RAMP RWY 09 CLSD.']) assert.deepEqual(closures(text), [], text);
});

test('military light-outage prose cannot discard a negation or a hypothetical status', () => {
  for (const id of ['7771675723861585', '6435955292157013']) {
    const original = record(id);
    assert.ok(parseNotam(original).facts.some(f => f.label === 'Obstacle Light Outage'));
    for (const qualifier of ['NOT CURRENTLY', 'NEVER', 'CANNOT BE', 'MAY BE', 'EXPECTED', 'WERE']) {
      const changed = { ...original, text: original.text.replace(/OTS|UNSERVICEABLE/, `${qualifier} UNSERVICEABLE`) };
      assert.ok(!parseNotam(changed).facts.some(f => f.label === 'Obstacle Light Outage'), changed.text);
      assert.deepEqual(auditNotam(changed), []);
    }
  }
});

test('truncated obstacle annotations preserve all source text and never repair the coordinate', () => {
  const r = record('1791591828556029'), point = notamObstacles(r)[0]!;
  assert.ok(point); assert.equal(point.preserveText, true); assert.equal(point.recovered, undefined);
  assert.deepEqual(point.coordinates, [-(81 + 41 / 60 + 43 / 3600), 41 + 23 / 60 + 2 / 3600]);
  assert.equal(point.heightAglFt, 1131); assert.equal(point.elevationMslFt, 2049);
  assert.deepEqual(notamObstacles({ ...r, text: r.text.replace('0814143.00W', '0814143.00') }), []);
});

test('complete transport permits interpretation and keeps source markers and sticky note scope', () => {
  const r = record('8832359922015464');
  assert.ok(!parseNotam(r).issues.includes('multipart'));
  assert.ok(presentNotam(r).blocks.some(b => b.kind === 'takeoff' && b.runway === '01L'));
  assert.match(presentNotam(r).searchText, /PART 2 OF 2/i);
  const text = 'PART 1 OF 2 IAP TEST. ILS RWY 09, AMDT 1... DELETE NOTE: END PART 1 OF 2\nPART 2 OF 2 LPV DA 500/HAT 300. END PART 2 OF 2';
  assert.equal(notamClauses(text, 128)!.find(c => c.source.includes('LPV'))!.state, 'instruction');
  assert.ok(presentNotam(notice({ text })).blocks.every(b => b.kind !== 'minima'));
  for (const changed of [r.text.replace('END PART 2 OF 2', ''), r.text.replace('PART 2 OF 2', 'PART 2 OF 3')]) {
    const bad = { ...r, text: changed };
    assert.ok(parseNotam(bad).issues.includes('multipart'));
    assert.ok(presentNotam(bad).blocks.every(b => !['minima', 'minima-group', 'takeoff'].includes(b.kind)));
  }
});

test('route-code periods and minima narrative do not corrupt procedure heading recognition', () => {
  assert.deepEqual(parseNotam(record('1788358383576695')).targets.map(t => t.title), ['SWFFT THREE']);
  assert.deepEqual(parseNotam(record('1758776646913857')).issues, []);
  for (const text of ['STAR TEST, CA. DELETE NOTE: SWFFT THREE ARRIVAL (RNAV) (SWFFT.SWFFT3)...',
    'STAR TEST, CA. SWFFT THREE ARRIVAL (RNAV) (SWFFT.SWFFT3...',
    'STAR TEST, CA. SWFFT THREE ARRIVAL (RNAV) (UNKNOWN WORDS)...']) assert.equal(parseNotam(notice({ text })).targets.length, 0, text);
});

test('displaced-threshold context licenses only the adjacent declared-distance clause and retains exact evidence', () => {
  const r = record('5197789173678098'), reading = presentNotam(r), block = reading.blocks.find(b => b.kind === 'distances')!;
  assert.equal(block.kind, 'distances'); if (block.kind !== 'distances') return;
  assert.equal(block.runway, '36');
  assert.deepEqual(block.values, [{ label: 'TORA', value: '7502 FT' }, { label: 'TODA', value: '7502 FT' },
    { label: 'ASDA', value: '7502 FT' }, { label: 'LDA', value: '7002 FT' }]);
  assert.equal(block.runwaySource?.text, 'RWY 36 THR DISPLACED 500FT.');
  assert.deepEqual(auditNotam(r), []);
  assert.ok(auditValueBindings('DECLARED DIST: TORA 7502FT TODA 7502FT ASDA 7502FT LDA 7002FT.', { ...block, runway: '18' }).length);
  for (const prefix of ['RWY 18/36 THR DISPLACED 500FT.', 'RWY 36 THR DISPLACED 500.', 'RWY 36 THR DISPLACED 500FT EXC JETS.',
    'RWY 36 THR DISPLACED 500FT. OTHER WORK.', 'NOTE: RWY 36 THR DISPLACED 500FT.']) {
    const changed = notice({ text: `${prefix} DECLARED DIST: TORA 7502FT LDA 7002FT.` });
    assert.ok(presentNotam(changed).blocks.every(b => b.kind !== 'distances'), prefix);
  }
});

test('observed visibility spelling, doubled field separators and explicit equipment minimums remain atomic', () => {
  assert.ok(presentNotam(record('1777656361642306')).blocks.some(b => b.kind === 'minima' && b.rows.some(r => r.values.some(v => v.label === 'Visibility' && v.value === 'RVR 3000'))));
  const dme = presentNotam(record('1774959967505386')).blocks.find(b => b.kind === 'minima' && /^DME MINIMUMS$/i.test(b.context ?? ''));
  assert.ok(dme); assert.equal(dme.kind, 'minima'); if (dme.kind !== 'minima') return;
  assert.equal(dme.scope, 'S-30C');
  const r = notice({ text: 'LNAV/VNAV DA 1900//HAT 516 ALL CATS, VISIBLITY CAT C 1 3/8.' });
  const block = presentNotam(r).blocks[0]!; assert.equal(block.kind, 'minima');
  if (block.kind === 'minima') assert.deepEqual(block.rows[0]!.values, [{ label: 'DA', value: '1900' }, { label: 'HAT', value: '516' }]);
  assert.deepEqual(auditNotam(r), []);
  for (const text of ['LNAV DA 1900//516', 'LNAV DA 1900//HAT CAT C 516', 'LNAV VISIBLITY 4000FT',
    'LNAV VIS 1//2', 'LNAV DA 1900//UNKNOWN 516']) assert.ok(presentNotam(notice({ text })).blocks.every(b => b.kind !== 'minima'), text);
  const vcoa = captured.cases.find(c => c.record.text.includes('FOR VCOA'))!;
  assert.ok(presentNotam(vcoa.record as NotamRecord).blocks.some(b => b.kind === 'takeoff' && b.options.some(o => o.condition === 'For VCOA')));
});
