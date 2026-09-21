import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalProceduresData, type FeatureCollectionResponse, type TerminalProceduresData } from '@zlayer/contracts';
import { codedTerminalSelection, createRouteResolver, terminalPaths, routeDraftFromText } from '@zlayer/domain';
import raw from './fixtures/coded-terminal-procedures.json';
import { parseRouteEntries } from '../src/layers/routes/draft-storage';
import { setRouteDeparture, setRouteArrival, sameRouteDraft, moveRouteEntry } from '../src/layers/routes/draft';
import { routeExportText } from '../src/layers/routes/export';
import { removeRoutePoint } from '../src/layers/routes/removal';
import { directToRoutePoint } from '../src/layers/routes/direct-to';

assert.ok(isTerminalProceduresData(raw));
const data: TerminalProceduresData = raw;
const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
  meta: { layer: 'airports', revision: data.metadata.effectiveDate, returned: 3, truncated: false },
  features: ['KSJC', 'KSNA', 'PAAQ'].map((ident, i) => ({ type: 'Feature', id: ident, properties: { ident, icaoId: ident,
    faaId: ident.startsWith('K') ? ident.slice(1) : 'PAQ' }, geometry: { type: 'Point', coordinates: [
      [-121.929, 37.362], [-117.868, 33.676], [-149.089, 61.595],
    ][i]! as [number, number] } })),
};
const resolve = createRouteResolver([airports], undefined, data);
const sid = data.codedProcedures!.procedures.find(p => p.ident === 'SPTNS1')!;
const star = data.codedProcedures!.procedures.find(p => p.ident === 'OHSEA3')!;
const select = (kind: 'departure' | 'arrival', runway: string, transition: string) => {
  const p = kind === 'departure' ? sid : star;
  const path = terminalPaths(p).find(p => p.runway === runway && p.transition === transition)!;
  assert.ok(path);
  return codedTerminalSelection(p, path, data.metadata.effectiveDate);
};

test('CIFP SID supplies its runway, constraints, arcs and enroute endpoint without NASR fix downloads', () => {
  const draft = routeDraftFromText('KSJC KSNA');
  const plan = resolve(setRouteDeparture(draft, draft.entries[0]!, select('departure', 'RW30L', 'VLREE')));
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.waypoints.map(p => p.ident), ['KSJC', 'RW30L', 'STCLR', 'SPTNS', 'TECKY', 'VLREE', 'KSNA']);
  assert.ok(plan.approachDepictions?.some(d => d.coordinates.length > 2));
  assert.ok(plan.waypoints.find(p => p.ident === 'STCLR')?.procedureConstraint?.includes('900 ft · ≤ 230 kt'));
  assert.equal(plan.legs.some(l => l.from.ident === 'KSJC'), false);
  assert.deepEqual(plan.planningConnections, [], 'do not connect the airport marker to its departure threshold or cut across curves');
  assert.equal(plan.legs.at(-1)?.from.ident, 'VLREE');
  assert.equal(plan.distanceNm, plan.legs.reduce((n, l) => n + l.distanceNm, 0));
  assert.equal(routeExportText(plan), 'KSJC SPTNS1 VLREE KSNA');
});

test('STAR entry and runway selection preserves vectors as an open schematic end', () => {
  const draft = routeDraftFromText('KSJC KSNA');
  const plan = resolve(setRouteArrival(draft, draft.entries[1]!, select('arrival', 'RW20R', 'ELLBC')));
  assert.equal(plan.waypoints.filter(p => p.ident === 'ELLBC').length, 1);
  assert.ok(plan.waypoints.some(p => p.ident === 'KLEVR'));
  assert.ok(plan.approachDepictions?.some(d => d.arrow));
  assert.equal(plan.legs.some(l => l.to.ident === 'KSNA'), false);
  assert.deepEqual(plan.planningConnections?.map(c => [c.from.ident, c.to.ident]), [['KLEVR', 'KSNA']]);
  assert.ok(plan.issues.some(i => /no fixed endpoint/.test(i.message)));
  assert.equal(routeExportText(plan), 'KSJC ELLBC OHSEA3 KSNA');
});

test('an intermediate airport reached before a SID stays in the connected sequence', () => {
  const draft = routeDraftFromText('KSNA KSJC KSNA');
  const plan = resolve(setRouteDeparture(draft, draft.entries[1]!, select('departure', 'RW30L', 'VLREE')));
  assert.deepEqual(plan.planningConnections?.map(c => [c.from.ident, c.to.ident]), [['KSJC', 'RW30L']]);
  assert.ok(plan.legs.some(l => l.from.ident === 'KSNA' && l.to.ident === 'KSJC'));
});

test('runway selection seeds heading departures with a surveyed threshold, never the airport reference point', () => {
  const p = data.codedProcedures!.procedures.find(p => p.ident === 'PALMR5')!;
  const path = terminalPaths(p).find(p => p.runway === 'RW16')!;
  assert.deepEqual(path.legs[0]!.fix?.coordinate, p.runways!.find(r => r.ident === 'RW16')!.coordinate);
  const draft = routeDraftFromText('PAAQ');
  const plan = resolve(setRouteDeparture(draft, draft.entries[0]!, codedTerminalSelection(p, path, data.metadata.effectiveDate)));
  assert.ok(plan.approachDepictions?.length);
  assert.equal(plan.legs.some(l => l.from.ident === 'PAAQ'), false);
});

test('coded selections survive persistence and branch reordering; expired or removed branches leave gaps', () => {
  let draft = routeDraftFromText('KSJC KSNA');
  draft = setRouteDeparture(draft, draft.entries[0]!, select('departure', 'RW30R', 'VLREE'));
  draft = setRouteArrival(draft, draft.entries[1]!, select('arrival', 'RW02L', 'ELLBC'));
  const saved = parseRouteEntries(JSON.parse(JSON.stringify(draft.entries)))!;
  assert.ok(sameRouteDraft(saved, draft));
  assert.equal(routeExportText(resolve(saved)), 'KSJC SPTNS1 VLREE ELLBC OHSEA3 KSNA');
  const reordered = structuredClone(data);
  for (const p of reordered.codedProcedures!.procedures) p.branches.reverse();
  assert.deepEqual(createRouteResolver([airports], undefined, reordered)(saved).waypoints.map(p => p.ident), resolve(saved).waypoints.map(p => p.ident));
  const stale = { entries: [{ ...saved.entries[0]!, departure: { ...saved.entries[0]!.departure!, effectiveDate: '2026-08-06' } }, saved.entries[1]!] };
  const plan = resolve(stale);
  assert.ok(plan.issues.some(i => /unavailable/.test(i.message)));
  assert.equal(plan.legs.some(l => l.from.ident === 'KSJC'), false);
  assert.equal(moveRouteEntry(saved, saved.entries[0]!.id, saved.entries[1]!.id).entries[1]!.departure?.codedRunway, 'RW30R');
});

test('procedure children cannot be flattened across curved, constrained or vector legs', () => {
  const draft = routeDraftFromText('KSJC KSNA');
  const attached = setRouteArrival(draft, draft.entries[1]!, select('arrival', 'RW20R', 'ELLBC'));
  const plan = resolve(attached), child = plan.waypoints.find(p => p.ident === 'OHSEA')!;
  assert.equal(removeRoutePoint(attached, plan, child), attached);
  const direct = directToRoutePoint(attached, plan, child, [-120, 35]);
  assert.equal(direct, attached);
});

test('coded guards reject malformed constraints, duplicated branches and edition mismatches', () => {
  for (const mutate of [
    (x: any) => { x.codedProcedures.metadata.effectiveDate = '2026-08-06'; },
    (x: any) => { x.codedProcedures.procedures[0].branches.push(x.codedProcedures.procedures[0].branches[0]); },
    (x: any) => { x.codedProcedures.procedures[0].branches[0].legs[0].speed = { knots: -20, restriction: '-' }; },
  ]) { const x = structuredClone(data); mutate(x); assert.equal(isTerminalProceduresData(x), false); }
});

test('coded SID and STAR endpoints connect an airway without separate editable fixes', () => {
  const withAirway = createRouteResolver([airports], {
    type: 'ZLayerAirways', metadata: data.metadata, airways: [{ id: 'test:V1', ident: 'V1', points: ['VLREE', 'ELLBC'],
      segments: [{ sequence: 1, from: 'VLREE', to: 'ELLBC', gap: false }] }],
  }, data);
  let draft = routeDraftFromText('KSJC V1 KSNA');
  draft = setRouteDeparture(draft, draft.entries[0]!, select('departure', 'RW30L', 'VLREE'));
  draft = setRouteArrival(draft, draft.entries[2]!, select('arrival', 'RW20R', 'ELLBC'));
  const plan = withAirway(draft);
  assert.equal(plan.airways[0]?.entry, 'VLREE');
  assert.equal(plan.airways[0]?.exit, 'ELLBC');
  assert.ok(plan.legs.some(l => l.from.ident === 'VLREE' && l.to.ident === 'ELLBC'));
  assert.equal(plan.waypoints.filter(p => p.ident === 'VLREE').length, 1);
  assert.equal(plan.waypoints.filter(p => p.ident === 'ELLBC').length, 1);
  assert.equal(plan.issues.some(i => i.code.startsWith('airway')), false);
  assert.equal(routeExportText(plan), 'KSJC SPTNS1 VLREE V1 ELLBC OHSEA3 KSNA');
  const invalid = { entries: draft.entries.map((entry, i) => i === 0 && entry.departure?.source === 'cifp'
    ? { ...entry, departure: { ...entry.departure!, codedBranches: ['missing'] } } : entry) };
  assert.equal(withAirway(invalid).waypoints.some(p => p.ident === 'VLREE'), false);
});

test('legacy saved selections migrate once and mismatched source/kind cannot change capabilities', () => {
  const coded = select('arrival', 'RW20R', 'ELLBC');
  const { kind: _kind, source: _source, ...legacy } = coded;
  const restore = (arrival: unknown) => parseRouteEntries([{ id: 'airport', text: 'KSNA', arrival }])!.entries[0]!;
  assert.deepEqual(restore(legacy).arrival, coded);
  assert.deepEqual(restore(restore(legacy).arrival).arrival, coded);
  for (const invalid of [{ ...legacy, kind: 'departure' }, { ...legacy, source: 'nasr' },
    { ...coded, branchId: undefined }, { ...coded, codedBranches: undefined }]) {
    assert.equal(restore(invalid).arrival, undefined);
    assert.equal(restore(invalid).text, 'KSNA');
  }
});
