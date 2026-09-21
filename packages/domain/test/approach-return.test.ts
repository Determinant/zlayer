import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isApproachRoutesData, type ApproachRoute } from '@zlayer/contracts';
import { approachEntryOptions, approachPreview, distanceNm } from '@zlayer/domain';
import { bearing } from '../src/approach-geometry.js';
import { difference, selfCrosses } from '../src/approach-path-geometry.js';

// FAA 2609 schema-2 export: KIWA ILS/LOC 30C, including all feeder starts.
const data: unknown = JSON.parse(readFileSync(new URL('./fixtures/approach-return.json', import.meta.url), 'utf8'));
assert.ok(isApproachRoutesData(data));
const procedure = data.procedures[0]!;

test('all KIWA entries retain the directed climb, intercept and station return as a schematic', () => {
  const entries = approachEntryOptions(procedure);
  assert.equal(entries.length, 7);
  for (const entry of entries) {
    const result = approachPreview(procedure, entry.id)!;
    assert.deepEqual(result.issues, [], entry.id);
    assert.equal(result.incomplete, false);
    const span = result.spans.find(s => s.phase === 'missed' && s.symbol !== 'hold')!;
    assert.equal(span.kind, 'schematic');
    assert.deepEqual(span.sources, ['I::040', 'I::050', 'I::060']);
    assert.ok(span.assumptions.includes('climb-return'));
    assert.ok(span.assumptions.includes('altitude-dependent'));
    assert.ok(span.assumptions.includes('no-wind-heading'));
    assert.ok(result.policy.climbScale > 1);
    assert.equal(result.points[span.from!]!.ident, 'RW30C');
    assert.equal(result.points[span.to!]!.ident, 'IWA');
    assert.deepEqual(span.coordinates.at(-1), procedure.final.at(-1)!.fix!.coordinate);
    assert.ok(!result.segments.some(s => s.phase === 'missed'), 'no synthetic missed track enters distance or terrain');
    assert.equal(result.points[result.exit!]!.hold, 'R');
  }
});

test('the KIWA return preserves the published heading, inbound radial and clockwise turn', () => {
  const result = approachPreview(procedure, 'vectors')!;
  const p = result.spans.find(s => s.assumptions.includes('climb-return'))!.coordinates;
  const headings = p.slice(1).map((v, i) => bearing(p[i]!, v));
  const intercept = headings.findIndex((h, i) => distanceNm(p[i]!, p[i + 1]!) > .01 && Math.abs(difference(h, 158)) < .01);
  assert.ok(intercept > 2, '145 magnetic heading after a sampled right turn');
  assert.ok(Math.abs(difference(headings[1]!, 315.6)) < .01, '302.6 magnetic climb');
  let turn = 0;
  for (let i = 2; i <= intercept; i++) {
    const change = difference(headings[i]!, headings[i - 1]!);
    assert.ok(change > 0 && change < 6, 'turn must remain clockwise through north');
    turn += change;
  }
  assert.ok(Math.abs(turn - 202.4) < .1);
  assert.ok(Math.abs(difference(bearing(p.at(-1)!, p.at(-2)!), 28)) < .01, 'on IWA R-015 with station declination');
  assert.equal(selfCrosses(p), true, 'the justified plan-view crossing remains visible');
  assert.equal(selfCrosses(p.slice(0, -1)), false, 'no crossing within either turn');
});

test('missing or ambiguous climb/return constraints do not waive crossing review', () => {
  const mutations: [string, (p: ApproachRoute) => void][] = [
    ['climb altitude absent', p => { delete p.final[4]!.altitude; }],
    ['return altitude absent', p => { delete p.final[6]!.altitude; }],
    ['return has no higher floor', p => { p.final[6]!.altitude!.first = '02800'; }],
    ['return has only an upper limit', p => { p.final[6]!.altitude!.restriction = '-'; }],
    ['climb uses a flight level', p => { p.final[4]!.altitude!.first = 'FL028'; }],
    ['station alignment absent', p => { delete p.final[6]!.reference!.declination; }],
    ['station coordinate absent', p => { delete p.final[6]!.reference!.coordinate; }],
    ['return ends off station', p => { p.final[6]!.reference!.coordinate![0] += .1; }],
    ['turn direction absent', p => { delete p.final[5]!.turn; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(procedure); mutate(changed);
    const result = approachPreview(changed, 'vectors')!;
    assert.ok(!result.spans.some(s => s.assumptions.includes('climb-return')), label);
    // Without a turn direction the shortest turn can depict a different path;
    // every remaining mutation retains the same return and an explicit issue.
    if (label !== 'turn direction absent') assert.equal(result.incomplete, true, label);
  }
});

test('an unresolved missed intercept retains the holding fix and racetrack without inventing an arrival', () => {
  const changed = structuredClone(procedure); delete changed.final[5]!.magneticCourse;
  for (const entry of approachEntryOptions(changed)) {
    const result = approachPreview(changed, entry.id)!;
    assert.equal(result.incomplete, true);
    assert.ok(result.issues.some(i => i.source === 'I::050' && i.code === 'missing-reference'));
    assert.ok(result.spans.some(s => s.kind === 'gap' && s.phase === 'missed'));
    const hold = result.points[result.exit!]!;
    assert.equal(hold.ident, 'IWA');
    assert.equal(hold.hold, 'R');
    assert.equal(hold.holdLength, '1 MIN');
    assert.equal(hold.holdCourse, 13);
    assert.equal(hold.arrivalCourse, undefined);
    assert.ok(result.depictions.some(d => d.kind === 'hold' && d.phase === 'missed'));
    assert.ok(result.spans.filter(s => s.symbol === 'missed').every(s =>
      s.to === undefined && s.assumptions.includes('open-termination')),
    'retain a known prefix without inventing a completed return');
    assert.ok(!result.segments.some(s => s.phase === 'missed'));
    assert.equal(result.points[result.landingEnd!]!.ident, 'RW30C');
  }
});
