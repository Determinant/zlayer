import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalProceduresData, type FeatureCollectionResponse } from '@zlayer/contracts';
import { approachEntryLegs, codedApproachLabel, codedTerminalSelection, terminalPaths, createRouteResolver, routeDraftFromText, type RouteApproach } from '@zlayer/domain';
import raw from './fixtures/route-approach-legs.json';
import { parseRouteEntries } from '../src/layers/routes/draft-storage';
import { sameRouteDraft, setRouteApproach, setRouteArrival } from '../src/layers/routes/draft';
import { directToRoutePoint } from '../src/layers/routes/direct-to';
import type { TerminalProceduresData, CodedTerminalProcedure } from '@zlayer/contracts';

assert.ok(isTerminalProceduresData(raw));
const terminal: TerminalProceduresData = raw;
const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
  meta: { layer: 'airports', revision: raw.metadata.effectiveDate, returned: 1, truncated: false },
  features: [{ type: 'Feature', id: 'KSFO', properties: { ident: 'KSFO' }, geometry: { type: 'Point', coordinates: [-122.375, 37.619] } }],
};
const resolve = createRouteResolver([airports], undefined, raw);

test('coded approach identity works without a chart title match and survives persistence', () => {
  const selected: RouteApproach = { kind: 'approach' as const, airportId: 'KSFO', procedureId: 'cifp:KSFO:I28R', name: codedApproachLabel('I28R'),
    cycle: '2609', source: 'cifp', entry: { routeId: 'KSFO:I28R', transitionId: 'transition:ARCHI', name: 'ARCHI', effectiveDate: raw.metadata.effectiveDate } };
  const original = routeDraftFromText('KSFO');
  const draft = setRouteApproach(original, original.entries[0]!, selected);
  const restored = parseRouteEntries(JSON.parse(JSON.stringify(draft.entries)))!;
  assert.ok(sameRouteDraft(draft, restored));
  const plan = resolve(restored);
  assert.deepEqual(plan.issues, []);
  assert.ok(plan.waypoints.some(p => p.ident === 'RW28R'));
  assert.ok(plan.legs.length > 0);
  for (const change of [{ airportId: 'KSJC' }, { entry: { ...selected.entry!, effectiveDate: '2026-08-06' } }]) {
    const invalid = setRouteApproach(draft, draft.entries[0]!, { ...selected, ...change });
    assert.ok(resolve(invalid).issues.some(i => i.code === 'approach-unavailable'));
    assert.equal(resolve(invalid).legs.length, 0);
  }
});

test('entering at a coded fix retains its altitude and speed restrictions', () => {
  const route = structuredClone(terminal.approaches!.procedures.find(p => p.id === 'KSFO:I28R')!);
  Object.assign(route.transitions[0]!.legs[0]!, { altitude: { first: '05000', second: '', restriction: '+' }, speed: { knots: 210, restriction: '-' } });
  const first = approachEntryLegs(route, `transition:${route.transitions[0]!.id}`)![0]!;
  assert.deepEqual(first.altitude, { first: '05000', second: '', restriction: '+' });
  assert.deepEqual(first.speed, { knots: 210, restriction: '-' });
});

test('STAR to approach joins preserve shared endpoints and expose unmatched entries', () => {
  const route = terminal.approaches!.procedures.find(p => p.id === 'KSFO:I28R')!;
  const archi = route.transitions.find(t => t.id === 'ARCHI')!.legs[0]!.fix!;
  const star: CodedTerminalProcedure = { id: 'KSFO:arrival:TEST1', airport: 'KSFO', ident: 'TEST1', kind: 'arrival', branches: [
    { id: '5:', routeType: '5', transition: '', legs: [
      { id: '5::010', path: 'IF', fix: { ident: 'ENTRY', coordinate: [-122.5, 38] } },
      { id: '5::020', path: 'TF', fix: archi },
    ] },
  ] };
  const data: TerminalProceduresData = { ...terminal, codedProcedures: { type: 'ZLayerCodedTerminalProcedures',
    metadata: { ...raw.metadata, schemaVersion: 1 }, procedures: [star] } };
  const resolve = createRouteResolver([airports], undefined, data);
  let draft = routeDraftFromText('KSFO');
  draft = setRouteArrival(draft, draft.entries[0]!, codedTerminalSelection(star, terminalPaths(star)[0]!, data.metadata.effectiveDate));
  draft = setRouteApproach(draft, draft.entries[0]!, { kind: 'approach' as const, airportId: 'KSFO', procedureId: 'cifp:KSFO:I28R', name: codedApproachLabel('I28R'),
    cycle: '2609', source: 'cifp', entry: { routeId: route.id, transitionId: 'transition:ARCHI', name: 'ARCHI', effectiveDate: data.metadata.effectiveDate } });
  const plan = resolve(draft);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.planningConnections, [], 'shared STAR/approach endpoints need no extra connection');
  assert.deepEqual(plan.waypoints.find(p => p.layer === 'airports')?.approachArrival?.coordinate, archi.coordinate);
  const child = plan.waypoints.find(p => p.ident === 'AXMUL')!;
  const direct = directToRoutePoint(draft, plan, child, [-122, 37]);
  assert.notEqual(direct, draft);
  assert.equal(direct.entries.find(e => e.text === 'KSFO')?.arrival, undefined);
  const disconnected = setRouteApproach(draft, draft.entries[0]!, { ...draft.entries[0]!.approach!,
    entry: { ...draft.entries[0]!.approach!.entry!, transitionId: 'transition:DUMBA', name: 'DUMBA' } });
  assert.ok(resolve(disconnected).issues.some(i => /STAR ends at ARCHI/.test(i.message)));
  assert.equal(resolve(disconnected).legs.some(l => l.from.ident === 'ARCHI' && l.to.ident === 'DUMBA'), false);
  assert.deepEqual(resolve(disconnected).planningConnections?.map(c => [c.from.ident, c.to.ident]), [['ARCHI', 'DUMBA']]);
});
