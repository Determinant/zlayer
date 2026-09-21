import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isTerminalProceduresData } from '@zlayer/contracts';
import { approachEntryOptions, approachIdent, approachPreview, findApproachRoute } from '@zlayer/domain';

const data: unknown = JSON.parse(readFileSync(new URL('./fixtures/route-approach-california.json', import.meta.url), 'utf8'));
assert.ok(isTerminalProceduresData(data));
const routes = data.approaches!;

test('combined conventional approach titles preserve the coded type, runway and variant', () => {
  for (const [title, ident] of [
    ['VOR/DME OR GPS-B', 'VDM-B'], ['VOR OR GPS-A', 'VOR-A'],
    ['VOR OR TACAN RWY 22', 'S22'], ['VOR OR TACAN RWY 30', 'S30'],
    ['VOR OR TACAN-A', 'VOR-A'], ['VOR/DME OR TACAN Y RWY 05R', 'D05RY'],
    ['NDB OR GPS-A', 'NDB-A'],
  ]) assert.equal(approachIdent(title!), ident, title);
  for (const title of ['HI-VOR OR TACAN RWY 22', 'ILS OR GPS RWY 22', 'NDB OR TACAN-A',
    'VOR Z OR GPS Y RWY 22', 'VOR OR GPS-A (CAT II)']) assert.equal(approachIdent(title), undefined, title);
  const catalina = findApproachRoute(routes, 'KAVX', 'VOR/DME OR GPS-B')!;
  assert.equal(catalina.id, 'KAVX:VDM-B');
  assert.ok(approachEntryOptions(catalina).length > 0);
  const previews = approachEntryOptions(catalina).map(e => approachPreview(catalina, e.id)!);
  assert.ok(previews.every(p => !p.incomplete));
  assert.ok(previews.some(p => p.spans.some(s => s.kind === 'schematic' && s.symbol === 'procedure-turn')));
});

test('an IF-only RNP entry preserves the curved final and never fabricates VTF', () => {
  const procedure = routes.procedures.find(p => p.id === 'KLGB:H12')!;
  assert.deepEqual(approachEntryOptions(procedure), [{ id: 'final:0', name: 'BREKE (IF)', kind: 'fix' }]);
  const preview = approachPreview(procedure, 'final:0')!;
  assert.equal(preview.incomplete, false);
  assert.equal(preview.extension, undefined);
  assert.equal(preview.points[0]!.ident, 'BREKE');
  assert.equal(preview.points[preview.landingEnd!]!.ident, 'RW12');
  assert.equal(preview.segments.filter(s => s.coordinates.length > 2).length, 3, 'retain all three RF arcs');
  assert.equal(approachPreview(procedure, 'vectors'), undefined);
  for (const role of ['FAF', undefined] as const) {
    const changed = structuredClone(procedure);
    if (role) changed.final[0]!.fix!.role = role;
    else delete changed.final[0]!.fix!.role;
    assert.ok(!approachEntryOptions(changed).some(e => e.id === 'final:0'), 'do not infer an IF entry from an unclassified fix or FAF');
  }
  const changed = structuredClone(procedure);
  changed.final[0]!.missed = true;
  assert.deepEqual(approachEntryOptions(changed), [], 'never offer a missed-approach fix as the landing entry');
});

test('an FC feeder without an IAF tag is selectable and retains its bounded outbound course', () => {
  const procedure = routes.procedures.find(p => p.id === 'KMCE:B12')!;
  assert.equal(procedure.transitions[0]!.legs[0]!.path, 'FC');
  assert.equal(procedure.transitions[0]!.legs[0]!.fix!.role, undefined);
  assert.ok(approachEntryOptions(procedure).some(e => e.id === 'transition:MOD' && e.name === 'MOD'));
  const preview = approachPreview(procedure, 'transition:MOD')!;
  assert.equal(preview.points[0]!.ident, 'MOD');
  assert.equal(preview.incomplete, false);
  const feeder = preview.segments.find(s => s.from === 0)!;
  assert.equal(preview.points[feeder.to]!.ident, 'AJOJO');
  assert.equal(feeder.coordinates.length, 3, 'retain the FC termination within the bounded course');
  const incomplete = structuredClone(procedure);
  delete incomplete.transitions[0]!.legs[0]!.distance;
  const gap = approachPreview(incomplete, 'transition:MOD')!;
  assert.equal(gap.incomplete, true);
  assert.ok(!gap.segments.some(s => s.from === 0), 'do not turn incomplete FC data into a direct leg');
});
