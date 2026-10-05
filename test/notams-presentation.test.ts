import assert from 'node:assert/strict';
import test from 'node:test';
import { presentNotam } from '../src/layers/notams/presentation';
import { departureNotice, notice } from './fixtures/notams';

test('departure minimums retain each runway, climb requirement and visual alternative', () => {
  const record = departureNotice(), before = structuredClone(record);
  const presentation = presentNotam(record);
  assert.deepEqual(presentation.blocks, [
    { kind: 'context', text: 'ODP · Test Municipal, Test City, CA' },
    { kind: 'heading', text: 'Takeoff minimums & obstacle departure procedures', detail: 'Amendment 1' },
    { kind: 'takeoff', runway: '13', options: [{ minimums: 'Standard minimums', climb: { gradient: '412', altitude: '3500' } }, { minimums: '3100-3', condition: 'For climb in visual conditions' }] },
    { kind: 'takeoff', runway: '31', options: [{ minimums: 'Standard minimums', climb: { gradient: '210', altitude: '2300' } }, { minimums: '3100-3', condition: 'For climb in visual conditions' }] },
    { kind: 'text', text: 'All other data remains as published.' },
  ]);
  assert.match(presentation.searchText, /Takeoff minimums Runway 13 Standard minimums Minimum climb 412 ft\/NM to 3500\s+Or 3100-3\s+For climb in visual conditions/);
  assert.deepEqual(record, before, 'source text and translations are untouched');
});

test('flat text, wrapped conditions and a complete local-format fallback have the same presentation', () => {
  const record = departureNotice(), expected = presentNotam(record).blocks;
  for (const text of [record.text.replaceAll('\n', ' '), record.text.replaceAll('CLIMB IN VISUAL', 'CLIMB\nIN VISUAL'), record.translations[0]!.text]) {
    assert.deepEqual(presentNotam({ ...record, text }).blocks, expected);
  }
  assert.deepEqual(presentNotam({ ...record, text: '' }).blocks, expected);
});

test('unfamiliar restrictions, numbers and units prevent partial runway summaries', () => {
  for (const text of [
    'TAKE-OFF MINIMUMS RWY 13, STANDARD WITH MINIMUM CLIMB OF 412 FT/NM TO 3500, EXCEPT CAT A.',
    'TAKE-OFF MINIMUMS RWY 13, STANDARD WITH MINIMUM CLIMB OF 412 FT/NM TO 3500; OR 3100-3 WHEN TOWER OPEN.',
    'TAKE-OFF MINIMUMS RWY 13, STANDARD WITH MINIMUM CLIMB OF 412 FT/NM TO 3500, OR 3100-3 FOR CLIMB IN VISUAL CONDITIONS EXC AT NIGHT.',
    'TAKE-OFF MINIMUMS RWY 13, STANDARD WITH MINIMUM CLIMB OF 412 FT/MIN TO 3500.',
    'TAKE-OFF MINIMUMS RWY 37, STANDARD WITH MINIMUM CLIMB OF 412 FT/NM TO 3500.',
    'TAKE-OFF MINIMUMS RWY 13, STANDARD WITH MINIMUM CLIMB OF 412 FT/NM TO 3500 MSL.',
    'TAKE-OFF MINIMUMS RWY 13, NA.',
    'IF AUTHORIZED, TAKE-OFF MINIMUMS RWY 13, STANDARD.',
  ]) {
    const blocks = presentNotam(notice({ text })).blocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.kind, text.startsWith('IF ') ? 'instruction' : 'text');
    assert.ok('text' in blocks[0]!);
    assert.equal(blocks[0]!.text.toUpperCase(), text, 'only casing changes in unsupported clauses');
  }
});

test('coded and fractional minima are retained without guessing units or implying an alternative', () => {
  assert.deepEqual(presentNotam(notice({ text: 'TAKEOFF MINIMUMS RWY 09L/27R, 500-1 1/2 WITH MINIMUM CLIMB OF 200.5 FEET PER NM TO 2000.' })).blocks,
    [{ kind: 'takeoff', runway: '09L/27R', options: [{ minimums: '500-1 1/2', climb: { gradient: '200.5', altitude: '2000' } }] }]);
  assert.deepEqual(presentNotam(notice({ text: 'TAKEOFF MINIMUMS RWY 09L, 500-1/2.' })).blocks,
    [{ kind: 'takeoff', runway: '09L', options: [{ minimums: '500-1/2' }] }]);
});

test('contradictory or unknown validity stays visible in the readable body', () => {
  const record = departureNotice();
  for (const overrides of [
    { startsAt: null }, { startsAt: record.startsAt! + 60_000 }, { endsAt: record.endsAt! + 60_000 },
    { effectiveEnd: '202710052359' }, { text: record.text.replace(/EST$/, '') },
  ]) assert.match(presentNotam({ ...record, ...overrides }).searchText, /2610041159-2710042359/);
  assert.doesNotMatch(presentNotam(record).searchText, /2610041159-2710042359/);
});

test('paragraphs preserve decimals, procedure identifiers, unknown clauses and conditions', () => {
  const text = 'IAP TEST AIRPORT, CA.\nRNAV (RNP) Z RWY 30L, AMDT 4...\n' +
    'RNP 0.10 DA 480/HAT 420 ALL CATS, VIS ALL CATS RVR 4000. ' +
    'CHANGE NOTE TO READ: FOR INOP ALS, INCREASE RNP 0.10 ALL CATS VISIBILITY TO RVR 6000.\n' +
    'TEMPORARY CRANES UP TO 320 MSL.\nUNKNOWN RESTRICTION EXC CAT A; ONLY WHEN TOWER OPEN.';
  assert.deepEqual(presentNotam(notice({ text })).blocks, [
    { kind: 'context', text: 'IAP · Test Airport, CA' },
    { kind: 'heading', text: 'RNAV (RNP) Z RWY 30L', detail: 'Amendment 4' },
    { kind: 'minima', scope: 'RNP 0.10', rows: [
      { values: [{ label: 'DA', value: '480' }, { label: 'HAT', value: '420' }], categories: 'All categories' },
      { values: [{ label: 'Visibility', value: 'RVR 4000' }], categories: 'All categories' },
    ] },
    { kind: 'instruction', label: 'Replace note', text: 'For inoperative ALS, increase RNP 0.10 all categories visibility to RVR 6000.' },
    { kind: 'text', text: 'Temporary cranes up to 320 MSL.' },
    { kind: 'text', text: 'Unknown restriction EXC CAT A; only when tower open.' },
  ]);
});

test('oversized bodies, clauses and block counts retain the complete source', () => {
  for (const text of ['X'.repeat(65 * 1024), 'NOTICE. '.repeat(129).trim(), 'X'.repeat(2049)]) {
    assert.deepEqual(presentNotam(notice({ text })).blocks.map(block => 'text' in block ? { ...block, text: block.text.toUpperCase() } : block),
      [{ kind: 'text', text }]);
  }
});
