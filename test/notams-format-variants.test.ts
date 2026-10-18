import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotamRecord } from '@zlayer/contracts';
import captured from './fixtures/notams-formats-2026-10-15.json' with { type: 'json' };
import { notice, testProcedure } from './fixtures/notams';
import { parseNotam } from '../src/layers/notams/parser';
import { approachMinima } from '../src/layers/notams/minima';
import { declaredDistances } from '../src/layers/notams/distances';
import { presentNotam } from '../src/layers/notams/presentation';
import { notamObstacles } from '../src/layers/notams/obstacles';
import { chartedNotamPresentation } from '../src/layers/notams/chart';
import { auditNotam, auditMappedNotam, auditRenderedNotam } from '../tools/audit-notams';
import { auditValueBindings } from '../tools/notam-value-audit';
import { matchPlateNotams } from '../src/layers/notams/matcher';

const record = (name: string) => captured.cases.find(c => c.name === name)!.record as NotamRecord;

test('October 15 source variants preserve every value, word, scope and reader path', () => {
  for (const { name, record: raw } of captured.cases) {
    const source = raw as NotamRecord, before = JSON.stringify(source);
    assert.deepEqual(auditNotam(source), [], name);
    assert.deepEqual(auditRenderedNotam(source), [], name);
    assert.deepEqual(auditMappedNotam(source), [], name);
    assert.deepEqual(auditRenderedNotam(source, true), [], name);
    assert.equal(JSON.stringify(source), before, name);
  }
});

test('declared-distance heading order and independently headed runway rows retain exact bindings', () => {
  const source = record('declared-distances');
  const blocks = presentNotam(source).blocks.filter(b => b.kind === 'distances');
  assert.deepEqual(blocks, [
    { kind: 'distances', runway: '13R', values: [
      { label: 'TORA', value: '11882 FT' }, { label: 'TODA', value: '11882 FT' },
      { label: 'ASDA', value: '11882 FT' }, { label: 'LDA', value: '9839 FT' },
    ] },
    { kind: 'distances', runway: '31L', values: [
      { label: 'TORA', value: '11882 FT' }, { label: 'TODA', value: '11882 FT' },
      { label: 'ASDA', value: '11882 FT' }, { label: 'LDA', value: '11247 FT' },
    ] },
  ]);
  assert.ok(parseNotam(source).facts.some(f => f.label === 'Runway Segment Closed'));
  for (const heading of ['DECLARED DIST: RWY 09L', 'RWY 09L DECLARED DIST:', 'RWY 09L', 'DECLARED DISTANCES RWY 09L:']) {
    const text = `${heading} TORA: 6000FT LDA 0 FT.`;
    const block = declaredDistances(text)!;
    assert.deepEqual(block, { kind: 'distances', runway: '09L', values: [
      { label: 'TORA', value: '6000 FT' }, { label: 'LDA', value: '0 FT' },
    ] });
    assert.deepEqual(auditNotam(notice({ text })), [], text);
    assert.ok(auditValueBindings(text, { ...block, runway: '09R' }).length);
    assert.ok(auditValueBindings(text, { ...block, values: [...block.values].reverse() }).length);
    assert.ok(auditValueBindings(text, { ...block, values: block.values.slice(0, 1) }).length);
  }
  for (const text of ['DECLARED DIST:RWY 09L:TORA:6000FT LDA:0FT.', 'RWY 09L DECLARED DIST:TORA:6000 FT.']) {
    assert.ok(declaredDistances(text), text);
    assert.deepEqual(auditNotam(notice({ text })), [], text);
  }
});

test('distance states reject missing identities or units, repeats, qualifications and scope escape', () => {
  for (const text of [
    'DECLARED DIST: TORA 6000FT', 'RWY 39 TORA 6000FT', 'RWY 29G TORA 6000FT',
    'RWY 09L/27R TORA 6000FT', 'RWY 09L TORA 6000 LDA 5900FT', 'RWY 09L TORA 6000M',
    'RWY 09L TORA 6000FT TORA 5900FT', 'RWY 09L TORA 6000FT LDA',
    'RWY 09L TORA 6000FT EXC JETS', 'RWY 09L TORA 6000FT RWY 27R LDA 5900FT',
    'DECLARED DIST: RWY 09L DECLARED DIST: TORA 6000FT', 'RWY 09L DECLARED DIST:',
    'RWY09L TORA 6000FT', 'RWY 09LTORA 6000FT', 'RWY 09L TORA6000FT',
  ]) assert.equal(declaredDistances(text), undefined, text);
  for (const control of ['DELETE NOTE:', 'IF AUTHORIZED:', 'PART 1 OF 2']) {
    const text = `${control} RWY 09L TORA 6000FT. RWY 27R LDA 5900FT.`;
    assert.ok(presentNotam(notice({ text })).blocks.every(b => b.kind !== 'distances'), text);
    assert.deepEqual(auditNotam(notice({ text })), [], text);
  }
});

test('plural minima labels and semicolon rows bind altitude and visibility to their own categories', () => {
  const source = record('plural-minima');
  const block = presentNotam(source).blocks.find(b => b.kind === 'minima');
  assert.deepEqual(block, { kind: 'minima', scope: 'Circling', rows: [
    { categories: 'CAT A/B', values: [{ label: 'MDA', value: '1860' }, { label: 'HAA', value: '617' }] },
    { categories: 'CAT C', values: [{ label: 'MDA', value: '1960' }, { label: 'HAA', value: '717' }] },
    { categories: 'CAT C', values: [{ label: 'Visibility', value: '2' }] },
  ] });
  const text = 'CIRCLING CAT A/B MDAS 1860/HAA 617; VIS CAT C 2.';
  const parsed = approachMinima(text)!;
  assert.deepEqual(auditValueBindings(text, parsed), []);
  const swapped = structuredClone(parsed);
  [swapped.rows[0]!.categories, swapped.rows[1]!.categories] = ['CAT C', 'CAT A/B'];
  assert.ok(auditValueBindings(text, swapped).length);
  const changedLabel = structuredClone(parsed); changedLabel.rows[0]!.values[0]!.label = 'DA';
  assert.ok(auditValueBindings(text, changedLabel).length);
});

test('compact category tokens stay local to the row and cannot hide unknown words or missing labels', () => {
  const blocks = presentNotam(record('compact-categories')).blocks.filter(b => b.kind === 'minima');
  assert.deepEqual(blocks[0]?.rows, [
    { categories: 'All categories', values: [{ label: 'MDA', value: '1900' }, { label: 'HAT', value: '526' }] },
    { categories: 'CAT C/D', values: [{ label: 'Visibility', value: '1 1/2' }] },
  ]);
  for (const text of ['LNAV MDA 1900/HAT 516 ALLCATS; VIS CATC/D 1 3/8.',
    'CIRCLING VIS CAT C 2 1/4, CATD 2 1/2, CATE 2 3/4.']) {
    const block = approachMinima(text)!;
    assert.ok(block, text);
    assert.deepEqual(auditNotam(notice({ text })), [], text);
    assert.deepEqual(auditValueBindings(text, block), [], text);
  }
  for (const text of ['LNAV CATD ALL CATS MDA 600/HAT 300', 'LNAV MDA 600 HAT CATD 300',
    'LNAV MDA 600/HAT 300 CATDOG', 'LNAV MDA 600/HAT 300 ALLCATSX',
    'LNAV CATD 600/HAT 300', 'LNAV MDA 600/HAT 300; CATD 700',
    'LNAV VIS RVR 4000 CATC; CATD 5000', 'LNAV MDAS 600/HAT 300 EXC CATD',
    'LNAV MDAS 600/HAT 300; DELETE VIS CATD 2']) assert.equal(approachMinima(text), undefined, text);
});

test('an omitted obstacle keyword needs complete ordered fields and preserves source evidence', () => {
  const source = record('bare-obstacle'), parsed = parseNotam(source);
  assert.equal(parsed.subject, 'OBST');
  assert.equal(parsed.facts.find(f => f.kind === 'subject')?.evidence.text, parsed.body,
    'an inferred subject retains the complete field proof, not just the word TOWER');
  assert.ok(parsed.facts.some(f => f.label === 'Obstacle Light Outage'));
  for (const fact of parsed.facts) assert.equal(parsed.body.slice(fact.evidence.start, fact.evidence.end), fact.evidence.text);
  assert.equal(notamObstacles(source).length, 1);
  assert.equal(chartedNotamPresentation(source)!.presentation.searchText, presentNotam(source).searchText);
  for (const prefix of ['NOTE:', 'IF AUTHORIZED:', 'XYZ', 'SEE', 'DELETE', 'PART 1 OF 2']) {
    const changed = { ...source, text: `${prefix} ${source.text}`, translations: [] };
    assert.equal(parseNotam(changed).subject, undefined, prefix);
    assert.deepEqual(notamObstacles(changed), [], prefix);
  }
  for (const text of ['TOWER CLSD', 'TOWER LGT U/S', source.text.replace('1210FT (200FT AGL)', '')]) {
    assert.equal(parseNotam({ ...source, text, translations: [] }).subject, undefined, text);
  }
  for (const suffix of ['NOT U/S', 'U/S EXC TOP LIGHT', 'U/S WHEN EXTENDED',
    'ONLY TOP LGT U/S', 'PROVIDED AUTHORIZED LGT U/S', 'ADD NOTE: LGT U/S', 'EXCLUDING TOP LIGHT U/S']) {
    const changed = { ...source, text: source.text.replace(/U\/S$/, suffix) };
    assert.ok(!parseNotam(changed).facts.some(f => f.label === 'Obstacle Light Outage'), suffix);
  }
});

test('a malformed relative annotation cannot replace, repair or erase an explicit obstacle position', () => {
  const source = record('annotation-letter-o'), point = notamObstacles(source)[0]!;
  assert.deepEqual(point.coordinates, [-(162 + 35 / 60 + 48 / 3600), 66 + 53 / 60 + 54 / 3600]);
  assert.equal(point.heightAglFt, 80); assert.equal(point.elevationMslFt, 95);
  assert.equal(point.preserveText, true); assert.equal(point.recovered, undefined);
  assert.equal(source.text.slice(point.coordinateSpan.start, point.coordinateSpan.end), '665354N1623548W');
  assert.match(chartedNotamPresentation(source)!.presentation.searchText, /O\.3NM/);
  assert.deepEqual(auditMappedNotam(source), []);
  for (const text of [source.text.replace('665354N1623548W', '665354N1623548'),
    source.text.replace('665354N1623548W', '669054N1623548W'),
    source.text.replace('(O.3NM N OTZ)', '(ONLY WHEN ERECTED)'),
    source.text.replace('(O.3NM N OTZ)', '(O.3NM N OTZ EXC RWY 09)')]) {
    assert.deepEqual(notamObstacles({ ...source, text }), [], text);
  }
});

test('new grammars keep conditional minima and incomplete source headings unresolved', () => {
  const conditional = record('conditional-minima');
  assert.ok(presentNotam(conditional).blocks.every(b => b.kind !== 'minima' && b.kind !== 'minima-group'));
  assert.ok(!parseNotam(conditional).facts.some(f => f.kind === 'minima'));
  assert.ok(parseNotam(record('incomplete-heading')).issues.includes('headings'));
  const incomplete = record('incomplete-heading');
  assert.equal(parseNotam(incomplete).targets[0]!.amendmentMissing, true);
  const result = matchPlateNotams([incomplete], { status: 'resolved', airport: { faaId: 'HIO', icaoId: 'KHIO' },
    procedure: { ...testProcedure, kind: 'takeoff-minimums', name: 'TAKEOFF MINIMUMS', source: { ...testProcedure.source, amendmentNumber: '2' } },
    key: 'test', cycle: '2610', effectiveDate: '2026-10-01', expirationDate: '2026-10-29' });
  assert.equal(result.matches[0]?.outcome, 'review');
  assert.match(result.matches[0]!.reason, /notice amendment is missing/);
});
