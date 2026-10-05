import assert from 'node:assert/strict';
import test from 'node:test';
import { approachMinima } from '../src/layers/notams/minima';
import { presentNotam } from '../src/layers/notams/presentation';
import { notice } from './fixtures/notams';

// Invented values exercising syntax found across the 40-airport production sample.
test('approach altitude and visibility retain their separate category scopes', () => {
  assert.deepEqual(approachMinima('LNAV MDA 640/HAT 555 ALL CATS, VISIBILITY CATS C/D 1 1/4.'), {
    kind: 'minima', scope: 'LNAV', rows: [
      { values: [{ label: 'MDA', value: '640' }, { label: 'HAT', value: '555' }], categories: 'All categories' },
      { values: [{ label: 'Visibility', value: '1 1/4' }], categories: 'CAT C/D' },
    ],
  });
  assert.deepEqual(approachMinima('LNAV CAT A/B MDA 860/ HAT 488, VIS CAT A/B RVR 2400, CAT C/D MDA 880/HAT 508, VIS CAT C/D RVR 5000.')?.rows, [
    { categories: 'CAT A/B', values: [{ label: 'MDA', value: '860' }, { label: 'HAT', value: '488' }] },
    { categories: 'CAT A/B', values: [{ label: 'Visibility', value: 'RVR 2400' }] },
    { categories: 'CAT C/D', values: [{ label: 'MDA', value: '880' }, { label: 'HAT', value: '508' }] },
    { categories: 'CAT C/D', values: [{ label: 'Visibility', value: 'RVR 5000' }] },
  ]);
});

test('circling, sidestep, fix requirements and height types remain distinct', () => {
  const circling = approachMinima('CIRCLING CAT A MDA 800/HAA 650, CAT D MDA 900/HAA 750, VISIBILITY CAT D 3.');
  assert.equal(circling?.scope, 'Circling');
  assert.deepEqual(circling?.rows.map(row => row.categories), ['CAT A', 'CAT D', 'CAT D']);
  assert.deepEqual(circling?.rows[1]!.values, [{ label: 'MDA', value: '900' }, { label: 'HAA', value: '750' }]);
  const fix = approachMinima('ALPHA FIX MINIMUMS (DME REQUIRED): S-LOC 4L MDA 720/HAT 375 ALL CATS, VIS CATS C/D RVR 3500.');
  assert.equal(fix?.context, 'ALPHA fix minimums (DME REQUIRED)');
  assert.equal(fix?.scope, 'S-LOC 4L');
  assert.equal(approachMinima('SIDESTEP: RWY 7R MDA 560/HAT 432 ALL CATS.')?.scope, 'Sidestep runway 7R');
  assert.deepEqual(approachMinima('LNAV MDA 680/HAS 647.')?.rows[0]!.values, [{ label: 'MDA', value: '680' }, { label: 'HAS', value: '647' }]);
});

test('published minima spellings, decimals, slashes and footnote markers are preserved', () => {
  for (const [source, scope, values] of [
    ['RNP .15 DA 558/HAT 436, RVR 4000 ALL CATS.', 'RNP .15', [{ label: 'DA', value: '558' }, { label: 'HAT', value: '436' }]],
    ['LNAV/VNAV DA 978 HAT 486 ALL CATS.', 'LNAV/VNAV', [{ label: 'DA', value: '978' }, { label: 'HAT', value: '486' }]],
    ['S- ILS 33R DA 374/HAT250 ALL CATS.', 'S- ILS 33R', [{ label: 'DA', value: '374' }, { label: 'HAT', value: '250' }]],
    ['LNAV MDA440/HAT 408 ALL CATS.', 'LNAV', [{ label: 'MDA', value: '440' }, { label: 'HAT', value: '408' }]],
    ['LPV DA* 257/HAT 250 ALL CATS.', 'LPV', [{ label: 'DA*', value: '257' }, { label: 'HAT', value: '250' }]],
    ['*RNP 0.30 DA 589/HAT 579 ALL CATS.', '*RNP 0.30', [{ label: 'DA', value: '589' }, { label: 'HAT', value: '579' }]],
    ['S-ILS 9# DA 329/HAT 312 ALL CATS.', 'S-ILS 9#', [{ label: 'DA', value: '329' }, { label: 'HAT', value: '312' }]],
  ] as const) {
    const result = approachMinima(source);
    assert.equal(result?.scope, scope, source);
    assert.deepEqual(result?.rows[0]!.values, values, source);
  }
  assert.equal(approachMinima('RNP 0.30 DA 894/HAT 522 ALL CATS, VISIBILITY ALL CATS 1-1/2.')?.rows[1]!.values[0]!.value, '1-1/2');
});

test('standalone visibility amendments never acquire assumed units, procedure or categories', () => {
  assert.deepEqual(approachMinima('MDA 1400/HAT 750, VIS 1-1/2 ALL CATS.'), { kind: 'minima', scope: 'Minimums', rows: [
    { values: [{ label: 'MDA', value: '1400' }, { label: 'HAT', value: '750' }] },
    { categories: 'All categories', values: [{ label: 'Visibility', value: '1-1/2' }] },
  ] });
  assert.deepEqual(approachMinima('VISIBILITY CAT C 1 5/8, CAT D 1 3/4.'), { kind: 'minima', scope: 'Visibility', rows: [
    { categories: 'CAT C', values: [{ label: 'Visibility', value: '1 5/8' }] },
    { categories: 'CAT D', values: [{ label: 'Visibility', value: '1 3/4' }] },
  ] });
  assert.deepEqual(approachMinima('VISIBILITY RVR 1800.')?.rows, [{ values: [{ label: 'Visibility', value: 'RVR 1800' }] }]);
  assert.deepEqual(approachMinima('LNAV CATS C/D RVR 4500.')?.rows, [{ categories: 'CAT C/D', values: [{ label: 'RVR', value: '4500' }] }]);
  assert.equal(approachMinima('VIS CAT C RVR 4000, CAT D 5000.'), undefined, 'do not guess an omitted RVR label');
});

test('exceptions stay attached, and unsupported or conflicting qualifiers prevent partial minima', () => {
  assert.equal(approachMinima('LNAV MDA 500/HAT 493 ALL CATS, UNLESS ADVISED BY ATC THE CRANE DOWN.')?.condition,
    'Unless ADVISED BY ATC THE CRANE DOWN');
  for (const text of [
    'LNAV MDA 500/HAT 493 ALL CATS EXC CAT A.',
    'LNAV MDA 500/HAT 493 CAT A ALL CATS.',
    'LNAV MDA 500/HAT 493 ALL CATS; EXCEPT WHEN CRANE IS DOWN.',
    'LNAV MDA 500/HAT 493 ALL CATS, VISIBLITY ALL CATS RVR 3000.',
    'CIRCLING CAT A/B 960/HAA 648, CIRCLING CAT C MDA 980/HAA 668.',
    'S-ILS 22L RA 150/14 150 DA 160.',
    'LNAV/VNAV DA 488/444 HAT ALL CATS.',
    'LPV DA 387/HAT 357, RVR 3000 ALL CATS LNAV/VNAV DA 590/HAT 560 ALL CATS.',
    'DISREGARD NOTE: LNAV MDA 500/HAT 493 ALL CATS.',
    'IF AUTHORIZED: LNAV MDA 500/HAT 493 ALL CATS.',
  ]) assert.equal(approachMinima(text), undefined, text);
});

test('added, replaced and disregarded notes keep their action and full conditional wording', () => {
  for (const [prefix, label] of [['ADD NOTE', 'Add note'], ['CHANGE NOTE TO READ', 'Replace note'],
    ['DISREGARD NOTE', 'Disregard note'], ['DELETE NOTE', 'Delete note'], ['CHANGE EQUIPMENT NOTE TO READ', 'Replace equipment note']]) {
    const source = `${prefix}: FOR INOP ALS, INCREASE LPV ALL CATS VISIBILITY TO RVR 4500, LNAV CAT E VISIBILITY TO 1 1/2 SM.`;
    assert.deepEqual(presentNotam(notice({ text: source })).blocks, [{ kind: 'instruction', label,
      text: 'For inoperative ALS, increase LPV all categories visibility to RVR 4500, LNAV CAT E visibility to 1 1/2 SM.' }]);
  }
  assert.deepEqual(presentNotam(notice({ text: 'CHANGE NOTE: AUTOPILOT COUPLED APPROACH NA BELOW 200 FEET MSL TO READ AUTOPILOT COUPLED APPROACH NA BELOW 500 MSL.' })).blocks,
    [{ kind: 'instruction', label: 'Change note', text: 'Autopilot coupled approach NA below 200 feet MSL to read autopilot coupled approach NA below 500 MSL.' }]);
});

test('multi-sentence note edits cannot promote quoted or conditional minima into operative rows', () => {
  for (const prefix of ['DISREGARD NOTE:', 'ADD NOTE:', 'CHANGE NOTE TO READ:', 'NOTE:', 'DELETE', 'FOR INOP ALS,',
    'UNKNOWN PREFIX DISREGARD NOTE:']) {
    const text = `${prefix} LNAV MDA 500/HAT 400 ALL CATS. LPV DA 480/HAT 380 ALL CATS. VIS RVR 4000 ALL CATS.`;
    const blocks = presentNotam(notice({ text })).blocks;
    assert.ok(blocks.every(block => block.kind !== 'minima'), prefix);
    assert.ok(blocks.some(block => 'text' in block && block.text.includes('LPV DA 480/HAT 380 all CATS.')), prefix);
    assert.ok(blocks.some(block => 'text' in block && block.text.includes('VIS RVR 4000 all CATS.')), prefix);
  }
});

test('missed approach instructions and following exceptions retain fixes, directions and alternatives', () => {
  const source = 'MISSED APPROACH: CLIMB TO 520, THEN CLIMBING RIGHT TURN TO 2000 DIRECT ALPHA AND ON TRACK 015 TO BRAVO; IF UNABLE, SEE OTHER PROCEDURE.';
  assert.deepEqual(presentNotam(notice({ text: source })).blocks, [{ kind: 'instruction', label: 'Missed approach',
    text: 'Climb to 520, then climbing right turn to 2000 direct ALPHA and on track 015 to BRAVO; if unable, see other procedure.' }]);
  const exception = 'EXCEPT WHEN ADVISED BY ATCT THAT THIS CRANE IS DOWN.';
  assert.deepEqual(presentNotam(notice({ text: exception })).blocks,
    [{ kind: 'instruction', label: 'Exception', text: 'Except when advised by ATCT that this crane is down.' }]);
});
