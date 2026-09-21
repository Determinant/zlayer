import assert from 'node:assert/strict';
import test from 'node:test';
import { isApproachRoutesData } from '@zlayer/contracts';
import { approachEntryLegs, approachEntryOptions, approachPreview, distanceNm } from '@zlayer/domain';
import { approachCourse, arrivalBearing, bearing, destination } from '../src/approach-geometry.js';
import { difference, joinOutboundCourse, selfCrosses } from '../src/approach-path-geometry.js';
import fixture from './fixtures/approach-maneuvers.json' with { type: 'json' };

// Unmodified FAA CIFP 2609 records. Plate comparisons are documented in
// docs/reviews/iap-depiction-2026-09-21.md.
const data: unknown = fixture;
assert.ok(isApproachRoutesData(data));
const procedure = (id: string) => data.procedures.find(p => p.id === id)!;

test('a failed later intercept preserves the known missed climb and outbound radial', () => {
  for (const id of ['KLAN:I28L', 'KCOE:I06']) {
    const p = procedure(id), preview = approachPreview(p, 'vectors')!;
    const prefix = preview.spans.find(s => s.assumptions.includes('open-termination'))!;
    assert.ok(prefix, id);
    assert.equal(prefix.kind, 'schematic');
    assert.equal(prefix.phase, 'missed');
    assert.equal(prefix.from, preview.landingEnd);
    assert.equal(prefix.to, undefined);
    assert.ok(prefix.assumptions.includes('altitude-dependent'));
    assert.deepEqual(prefix.coordinates[0], preview.points[preview.landingEnd!]!.coordinate);
    assert.deepEqual(prefix.arrow?.coordinate, prefix.coordinates.at(-1));
    assert.ok(preview.spans.some(s => s.kind === 'gap' && s.from === prefix.from));
    assert.ok(preview.issues.some(i => i.path === 'CF' && i.code === 'inconsistent-constraints'));
    assert.ok(preview.spans.some(s => s.symbol === 'hold'));
    assert.ok(!preview.segments.some(s => s.phase === 'missed'), 'partial maneuver adds no route distance');
    if (id === 'KCOE:I06') {
      const fa = p.final.find(l => l.path === 'FA')!, radial = approachCourse(fa, p)!;
      const capture = prefix.coordinates.at(-2)!, end = prefix.coordinates.at(-1)!;
      assert.ok(distanceNm(capture, end) >= .5);
      for (const point of [capture, end]) assert.ok(Math.abs(difference(bearing(fa.fix!.coordinate, point), radial)) < .01,
        'FA captures COE R-350 rather than drawing a parallel heading');
      assert.equal(selfCrosses(prefix.coordinates), false);
    }
  }
});

test('published outbound distances and directed reversals are retained without a detour warning', () => {
  for (const [id, entry, direction] of [['KLNK:I18-Y', 'transition:LNK', 1], ['KPBF:I18', 'transition:PBF', -1]] as const) {
    const p = procedure(id), preview = approachPreview(p, entry)!, legs = approachEntryLegs(p, entry)!;
    assert.deepEqual(preview.issues, [], id);
    const span = preview.spans.find(s => s.legs.some(i => legs[i]!.path === 'FC'))!;
    const fc = legs[span.legs[0]!]!, a = span.coordinates[0]!, b = span.coordinates[1]!, c = span.coordinates[2]!;
    assert.equal(fc.path, 'FC');
    assert.ok(Math.abs(distanceNm(a, b) - fc.distance!) < .001, 'keep the entire coded outbound distance');
    assert.ok(difference(bearing(b, c), arrivalBearing(a, b)!) * direction > 0, 'keep the coded reversal side');
    assert.equal(selfCrosses(span.coordinates), false);
  }
});

test('IAP heading/course intercepts can capture an outbound course before climbing and returning', () => {
  for (const id of ['KPIH:S03', 'KSCH:I04']) {
    const p = procedure(id), fa = p.final.find(l => l.path === 'FA')!, radial = approachCourse(fa, p)!;
    for (const entry of approachEntryOptions(p)) {
      const preview = approachPreview(p, entry.id)!;
      assert.deepEqual(preview.issues, [], `${id} ${entry.id}`);
      const span = preview.spans.find(s => s.phase === 'missed' && s.symbol !== 'hold')!;
      assert.ok(span.assumptions.includes('course-capture'));
      assert.ok(span.coordinates.some((point, i, all) => i > 0 && distanceNm(all[i - 1]!, point) > .2 &&
        [point, all[i - 1]!].every(c => Math.abs(difference(bearing(fa.fix!.coordinate, c), radial)) < .01)),
      'retain a finite leg established on the referenced outbound ray');
      assert.ok(preview.spans.some(s => s.symbol === 'hold' && s.phase === 'missed'));
    }
  }
});

test('outbound capture follows the defined ray with a tangent join in either turn direction', () => {
  for (const origin of [[-115, 36], [179.99, 50]] as [number, number][]) for (const outbound of [0, 140, 280]) {
    for (const side of ['L', 'R'] as const) {
      const from = destination(origin, outbound + (side === 'L' ? 70 : -70), 3), heading = outbound;
      const coordinates = joinOutboundCourse(from, heading, origin, outbound, side)!;
      assert.ok(coordinates);
      const capture = coordinates.at(-1)!, tangent = arrivalBearing(coordinates.at(-2)!, capture)!;
      assert.ok(Math.abs(difference(bearing(origin, capture), outbound)) < .001);
      assert.ok(Math.abs(difference(tangent, arrivalBearing(origin, capture)!)) < 3);
      assert.ok(difference(bearing(from, coordinates[1]!), heading) * (side === 'L' ? -1 : 1) > 0);
      assert.equal(selfCrosses(coordinates), false);
    }
  }
});
