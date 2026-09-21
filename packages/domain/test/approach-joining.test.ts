import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isApproachRoutesData } from '@zlayer/contracts';
import { approachEntryLegs, approachEntryOptions, approachPreview, distanceNm } from '@zlayer/domain';
import { approachCourse, bearing } from '../src/approach-geometry.js';
import { difference } from '../src/approach-path-geometry.js';
import { joinApproachTransition } from '../src/approach-joining.js';

// FAA CIFP 2609, regenerated with separate airport-associated ILS DME antennas.
const data: unknown = JSON.parse(readFileSync(new URL('./fixtures/approach-joining.json', import.meta.url), 'utf8'));
assert.ok(isApproachRoutesData(data));
const procedure = (id: string) => data.procedures.find(p => p.id === id)!;

test('recovered source procedures retain their FAF, landing end and missed hold for every entry', () => {
  const unresolved = new Set(['KDEN:I35R', 'KHLN:I27-Y', 'KILM:I24-Y', 'KRGK:I09']);
  for (const p of data.procedures.filter(p => !unresolved.has(p.id))) for (const e of approachEntryOptions(p)) {
    const v = approachPreview(p, e.id)!, label = `${p.id} ${e.id}`;
    assert.deepEqual(v.issues, [], label);
    const faf = p.final.find(l => !l.missed && l.fix?.role === 'FAF')!.fix!;
    const map = p.final.find(l => !l.missed && l.fix?.role === 'MAP')!.fix!;
    assert.ok(v.landingEnd !== undefined, label);
    assert.equal(v.points[v.landingEnd]!.ident, map.ident, label);
    assert.ok(v.points.slice(0, v.landingEnd + 1).some(x => x.ident === faf.ident), label);
    assert.ok(v.spans.some(s => s.phase === 'missed' && s.symbol === 'hold'), label);
  }
});

test('procedure turns capture the published inbound course even when its fix has a different name', () => {
  for (const [id, entry] of [['KAWO:L34', 'transition:AW'], ['KCDR:I03', 'transition:WAXER'],
    ['KCHS:D21', 'transition:CHS'], ['KGLH:I18L', 'transition:GLH'], ['PABT:S02', 'transition:JEVUM'],
    ['KVDI:I25', 'transition:DBN']]) {
    const p = procedure(id!), v = approachPreview(p, entry!)!, legs = approachEntryLegs(p, entry!)!;
    const span = v.spans.find(s => s.symbol === 'procedure-turn')!;
    const pi = legs.find(l => l.path === 'PI')!, cf = legs[span.legs.at(-1)!]!;
    assert.equal(span.kind, 'schematic');
    assert.equal(cf.path, 'CF');
    assert.ok(span.coordinates.slice(0, -1).every(x => distanceNm(pi.fix!.coordinate, x) <= pi.distance! + .1), id);
    assert.deepEqual(span.coordinates.at(-1), cf.fix!.coordinate);
    assert.ok(Math.abs(difference(bearing(span.coordinates.at(-1)!, span.coordinates.at(-2)!) + 180,
      approachCourse(cf, p)!)) < .1, id);
    assert.ok(span.sources.includes(pi.id!) && span.sources.includes(cf.id!));
  }
});

test('a station at the MAP cannot make the procedure turn skip an intermediate fix or the FAF', () => {
  const p = procedure('PABT:S02'), legs = approachEntryLegs(p, 'transition:JEVUM')!;
  const pi = legs.findIndex(l => l.path === 'PI');
  assert.equal(legs[pi]!.fix!.ident, 'BTT');
  assert.equal(legs[pi + 1]!.fix!.ident, 'SUCNO');
  assert.equal(legs[pi + 2]!.fix!.ident, 'YUSNU');
  assert.equal(legs[pi + 2]!.fix!.role, 'FAF');
});

test('inbound joins reject incompatible references and retain visible fixes after the gap', () => {
  const p = structuredClone(procedure('KAWO:L34'));
  p.transitions.find(t => t.id === 'AW')!.legs.find(l => l.path === 'PI')!.reference!.id = 'unrelated-station';
  const v = approachPreview(p, 'transition:AW')!;
  assert.ok(v.spans.some(s => s.kind === 'gap'));
  assert.ok(v.points.some(x => x.ident === 'WATON' && x.role === 'FAF'));
  assert.equal(v.points[v.landingEnd!]!.ident, 'RW34');
  assert.ok(v.spans.some(s => s.phase === 'missed' && s.symbol === 'hold'));
  const short = structuredClone(procedure('KGLH:I18L'));
  short.transitions.find(t => t.id === 'GLH')!.legs.find(l => l.path === 'PI')!.distance = .2;
  assert.ok(approachPreview(short, 'transition:GLH')!.incomplete);
});

test('unresolved hold joins never select a same-name missed fix instead of the approach', () => {
  for (const [id, entry] of [['KILM:I24-Y', 'transition:GM'], ['KRGK:I09', 'transition:FGT']]) {
    const p = procedure(id!), legs = approachEntryLegs(p, entry!)!, v = approachPreview(p, entry!)!;
    assert.ok(legs.some(l => l.path === 'XX'));
    assert.ok(v.incomplete);
    assert.equal(v.points[v.landingEnd!]!.ident, p.final.find(l => l.fix?.role === 'MAP')!.fix!.ident);
  }
});

test('a feeder follows an unambiguous onward transition and refuses conflicting continuations', () => {
  const p = procedure('KRUQ:R20'), legs = approachEntryLegs(p, 'transition:JOTTA')!;
  assert.deepEqual(legs.filter(l => l.fix && !l.missed).map(l => l.fix!.ident), ['JOTTA', 'YIDPO', 'ZUGMY', 'ZUGMY', 'IKPEZ', 'RW20']);
  assert.ok(legs.some(l => l.id?.startsWith('A:YIDPO:')));
  const ambiguous = structuredClone(p), other = structuredClone(p.transitions.find(t => t.id === 'YIDPO')!);
  other.id = 'other'; ambiguous.transitions.push(other);
  assert.ok(approachPreview(ambiguous, 'transition:JOTTA')!.incomplete);
  const cycle = structuredClone(p), a = cycle.transitions.find(t => t.id === 'JOTTA')!, b = cycle.transitions.find(t => t.id === 'YIDPO')!;
  b.legs[1]!.fix = a.legs[0]!.fix!;
  cycle.transitions = [a, b];
  const joined = joinApproachTransition(cycle, a.legs);
  assert.ok(joined.length < 20 && joined.some(l => l.path === 'XX'));
});

test('Denver DME terminations use the DME antenna and retain a subsequent unresolved intercept', () => {
  for (const id of ['KDEN:I16L', 'KDEN:I17R', 'KDEN:I35L']) {
    const p = procedure(id), v = approachPreview(p, 'vectors')!, vd = p.final.find(l => l.path === 'VD')!;
    const span = v.spans.find(s => s.sources.includes(vd.id!))!;
    assert.notDeepEqual(vd.reference!.dmeCoordinate, vd.reference!.coordinate);
    assert.ok(span.coordinates.some(x => Math.abs(distanceNm(vd.reference!.dmeCoordinate!, x) - vd.distance!) < .001));
    assert.equal(span.kind, 'schematic');
    assert.ok(span.assumptions.includes('DME-plan-view'));
    const missing = structuredClone(p); delete missing.final.find(l => l.path === 'VD')!.reference!.dmeCoordinate;
    assert.ok(approachPreview(missing, 'vectors')!.issues.some(i => i.path === 'VD'));
  }
  const v = approachPreview(procedure('KDEN:I35R'), 'vectors')!;
  assert.ok(v.issues.some(i => i.path === 'VI' && i.code === 'no-forward-intersection'));
  assert.ok(!v.issues.some(i => i.path === 'VD'));
  assert.ok(v.spans.some(s => s.symbol === 'hold' && s.phase === 'missed'));
});
