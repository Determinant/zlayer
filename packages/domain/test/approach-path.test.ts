import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isApproachRoutesData, type ApproachRoute } from '@zlayer/contracts';
import { approachEntryOptions, approachPreview, distanceNm } from '@zlayer/domain';
import { approachCourse, bearing, destination } from '../src/approach-geometry.js';
import { difference, selfCrosses } from '../src/approach-path-geometry.js';
import { resolveApproachLegs } from '../src/approach-path.js';

// FAA 2609, generated from the publisher's approach-paths-cifp.txt source fixture.
const data: unknown = JSON.parse(readFileSync(new URL('./fixtures/approach-paths.json', import.meta.url), 'utf8'));
assert.ok(isApproachRoutesData(data));
const procedure = (id: string) => data.procedures.find(p => p.id === id)!;
const preview = (id: string, entry?: string) => {
  const p = procedure(id); return approachPreview(p, entry ?? approachEntryOptions(p)[0]!.id)!;
};

test('all entries in the source regression set resolve with explicit span quality and no invented route legs', () => {
  assert.equal(data.procedures.length, 16);
  for (const p of data.procedures) for (const entry of approachEntryOptions(p)) {
    const result = approachPreview(p, entry.id)!;
    assert.deepEqual(result.issues, [], `${p.id} ${entry.id}`);
    assert.equal(result.incomplete, false);
    assert.ok(result.landingEnd !== undefined && result.exit !== undefined);
    assert.ok(result.spans.every(s => s.legs.length && s.coordinates.every(p => p.every(Number.isFinite))));
    for (const span of result.spans) {
      assert.ok(span.kind !== 'gap');
      if (span.kind === 'schematic') assert.ok(span.assumptions.length);
      else assert.equal(span.assumptions.length, 0);
    }
    assert.equal(result.segments.length, result.spans.filter(s => s.kind === 'fixed').length);
    assert.equal(result.depictions.length, result.spans.filter(s => s.kind === 'schematic').length);
  }
});

test('Willows uses the ILA radial datum and a bounded right intercept without crossing itself', () => {
  const p = procedure('KWLW:S34'), result = preview(p.id, 'vectors');
  const missed = result.spans.find(s => s.phase === 'missed' && s.symbol !== 'hold')!;
  const map = result.points[result.landingEnd!]!;
  assert.deepEqual(missed.coordinates[0], map.coordinate);
  assert.equal(result.points[missed.to!]!.ident, 'WUNIP');
  assert.equal(selfCrosses(missed.coordinates), false);
  const inbound = p.final.find(l => l.missed && l.path === 'CF')!;
  assert.equal(inbound.reference!.declination, 18);
  assert.ok(Math.abs(difference(bearing(missed.coordinates[0]!, missed.coordinates[1]!), 341)) < .2);
  assert.ok(missed.coordinates.some((v, i, a) => i > 0 && distanceNm(a[i - 1]!, v) > .2 &&
    Math.abs(difference(bearing(a[i - 1]!, v), 214)) < .1), 'retain the 200 magnetic heading');
  assert.ok(Math.abs(difference(bearing(missed.coordinates.at(-1)!, missed.coordinates.at(-2)!) + 180,
    approachCourse(inbound, p)!)) < .1);
});

test('radial and DME terminations are reached before subsequent missed instructions', () => {
  for (const id of ['KLAX:I25L', 'KLAX:I25R', 'KTOA:I29R', 'KVNY:I16RZ']) {
    const p = procedure(id), result = preview(id, 'vectors');
    const leg = p.final.find(l => l.path === 'VR' || l.path === 'CD')!;
    const span = result.spans.find(s => s.phase === 'missed' && s.symbol !== 'hold')!;
    const interior = span.coordinates.slice(1, -1);
    if (leg.path === 'VR') assert.ok(interior.some(c => distanceNm(leg.reference!.coordinate!, c) > 1 &&
      Math.abs(difference(bearing(leg.reference!.coordinate!, c), leg.radial! + leg.reference!.declination!)) < .01), id);
    else assert.ok(interior.some(c => Math.abs(distanceNm(leg.reference!.dmeCoordinate!, c) - 1.5) < .001), id);
    assert.ok(span.assumptions.length && span.kind === 'schematic');
    const missing = structuredClone(p); delete missing.final.find(l => l.path === leg.path)!.reference;
    const unresolved = approachPreview(missing, 'vectors')!;
    assert.ok(unresolved.issues.some(i => i.code === 'missing-reference' && i.path === leg.path && i.source));
    assert.ok(unresolved.spans.some(s => s.kind === 'gap'));
  }
});

test('successive climbs retain their virtual endpoint before returning to the same station', () => {
  for (const id of ['KCMA:S26', 'KCEC:D12']) {
    const p = procedure(id), result = preview(id, 'vectors');
    const span = result.spans.find(s => s.phase === 'missed' && s.symbol !== 'hold')!;
    assert.equal(span.kind, 'schematic');
    assert.ok(span.legs.length >= 3);
    assert.ok(span.assumptions.includes('altitude-dependent'));
    assert.ok(span.coordinates.some(c => distanceNm(c, span.coordinates.at(-1)!) > 1));
    assert.equal(result.points[result.exit!]!.ident, p.final.at(-1)!.fix!.ident);
    assert.ok(!result.segments.some(s => s.phase === 'missed'));
  }
});

test('representative procedure turns stay within the published extent and return along the inbound course', () => {
  for (const id of ['KAPC:S06', 'KAVX:VDM-B', 'KPOC:VOR-A']) {
    const p = procedure(id);
    const result = approachEntryOptions(p).map(e => approachPreview(p, e.id)!).find(r => r.spans.some(s => s.symbol === 'procedure-turn'))!;
    const source = [...p.transitions.flatMap(t => t.legs), ...p.final];
    const index = source.findIndex(l => l.path === 'PI'), pi = source[index]!, next = source.find(l => l.path === 'CF' && l.fix?.ident === pi.fix!.ident)!;
    const span = result.spans.find(s => s.symbol === 'procedure-turn')!;
    assert.ok(span, id);
    assert.equal(span.kind, 'schematic');
    assert.deepEqual(span.coordinates[0], pi.fix!.coordinate);
    assert.deepEqual(span.coordinates.at(-1), pi.fix!.coordinate);
    assert.ok(span.coordinates.every(c => distanceNm(pi.fix!.coordinate, c) <= pi.distance!));
    assert.ok(Math.abs(difference(bearing(span.coordinates[0]!, span.coordinates[1]!), approachCourse(next, p)! + 180)) < .01);
    assert.ok(Math.abs(difference(bearing(span.coordinates.at(-1)!, span.coordinates.at(-2)!) + 180, approachCourse(next, p)!)) < .01);
    assert.notEqual(span.from, span.to, 'revisited fixes are distinct occurrences');
  }
});

test('Oakland can extend its representative climb without changing the 340 heading or inbound radial', () => {
  const result = preview('KOAK:I28R', 'vectors');
  assert.ok(result.policy.climbScale > 1);
  const span = result.spans.find(s => s.phase === 'missed' && s.symbol !== 'hold')!;
  assert.equal(selfCrosses(span.coordinates), false);
  assert.ok(span.coordinates.some((c, i, a) => i > 0 && distanceNm(a[i - 1]!, c) > .2 &&
    Math.abs(difference(bearing(a[i - 1]!, c), 354)) < .1));
});

test('Redding FC terminates at its coded 7.9 NM extent and snaps only within source precision', () => {
  const result = preview('KRDD:I35', 'transition:RBL'), span = result.spans[0]!;
  assert.equal(span.kind, 'fixed');
  assert.equal(span.coordinates.length, 2);
  assert.equal(result.points[span.to!]!.ident, 'DIBLE');
  assert.ok(Math.abs(distanceNm(span.coordinates[0]!, span.coordinates.at(-1)!) - 7.9) < .05);
});

test('manual termination and impossible intersections remain explained gaps, never direct connections', () => {
  const base: ApproachRoute = { id: 'TEST:I01', airport: 'TEST', ident: 'I01', transitions: [], final: [] };
  for (const path of ['VM', 'FM', 'XX', 'VI']) {
    const result = resolveApproachLegs(base, [{ path: 'IF', fix: { ident: 'START', coordinate: [0, 0] } },
      { path, trueCourse: 270, id: 'I::020' }, { path: 'CF', trueCourse: 0, fix: { ident: 'END', coordinate: [.1, .1] } }]);
    assert.ok(result.incomplete);
    assert.equal(result.segments.length, 0);
    assert.ok(result.issues.some(i => i.source === 'I::020'));
    assert.ok(result.spans.some(s => s.kind === 'gap'));
  }
  // A known fix restores fixed geometry after an assumed climb/direct segment.
  const end = destination([0, 0], 90, 5);
  const result = resolveApproachLegs(base, [{ path: 'IF', fix: { ident: 'A', coordinate: [0, 0] } },
    { path: 'CA', trueCourse: 0 }, { path: 'DF', turn: 'R', fix: { ident: 'B', coordinate: end } },
    { path: 'TF', fix: { ident: 'C', coordinate: destination(end, 90, 5) } }]);
  assert.deepEqual(result.spans.map(s => s.kind), ['schematic', 'fixed']);
  assert.equal(result.segments.length, 1);
});
