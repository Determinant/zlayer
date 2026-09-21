import assert from 'node:assert/strict';
import test from 'node:test';
import { isApproachRoutesData } from '@zlayer/contracts';
import { approachEntryOptions, approachPreview, distanceNm } from '@zlayer/domain';
import { arrivalBearing, bearing } from '../src/approach-geometry.js';
import { difference, selfCrosses } from '../src/approach-path-geometry.js';
import fixture from './fixtures/approach-course-capture.json' with { type: 'json' };

// FAA CIFP 2609; plate https://aeronav.faa.gov/d-tpp/2609/06970IL12L.PDF.
// The return starts at TUPUC/LAS 10 on R-310 and turns right to R-330 inbound.
const data: unknown = fixture;
assert.ok(isApproachRoutesData(data));
const procedure = data.procedures[0]!;

test('KVGT captures LAS R-330 near the missed turn and follows it inbound to the hold', () => {
  for (const entry of approachEntryOptions(procedure)) {
    const preview = approachPreview(procedure, entry.id)!;
    assert.deepEqual(preview.issues, []);
    const span = preview.spans.find(s => preview.points[s.from!]?.ident === 'TUPUC')!;
    const from = span.coordinates[0]!, capture = span.coordinates.at(-2)!, las = span.coordinates.at(-1)!;
    assert.equal(span.kind, 'schematic');
    assert.equal(span.phase, 'missed');
    assert.ok(span.sources.includes('I::070'));
    assert.ok(span.assumptions.includes('course-capture'));
    assert.deepEqual(from, procedure.final[5]!.fix!.coordinate);
    assert.deepEqual(las, procedure.final[6]!.fix!.coordinate);
    assert.ok(distanceNm(capture, las) > 9 && distanceNm(capture, las) < 10.5, 'capture early, not 1 NM before LAS');
    assert.ok(Math.abs(difference(bearing(las, capture), 330 + 15)) < .001, 'use LAS station declination');
    assert.ok(Math.abs(difference(arrivalBearing(capture, las)!, 150 + 15)) < .001);
    const incoming = preview.spans.find(s => preview.points[s.to!]?.ident === 'TUPUC')!;
    const heading = arrivalBearing(incoming.coordinates.at(-2)!, from)!;
    const initialTurn = difference(bearing(from, span.coordinates[1]!), heading);
    assert.ok(initialTurn > 0 && initialTurn < 3, 'retain the coded right turn from the arriving course');
    assert.equal(selfCrosses(span.coordinates), false);
    assert.ok(!preview.segments.some(s => s.from === span.from && s.to === span.to), 'schematic turn is excluded from route distance');
    assert.equal(preview.points[preview.exit!]!.ident, 'LAS');
    assert.ok(preview.spans.some(s => s.symbol === 'hold' && s.phase === 'missed'));
  }
});
