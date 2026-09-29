import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalProceduresData } from '@zlayer/contracts';
import { attachRouteDepartures, createRouteResolver, radialFormsForPoint, routeDraftFromText, routeDraftText } from '@zlayer/domain';
import { expandRouteEntry, routeEntryExpansion } from '../src/layers/routes/expansion';
import { removeRouteEntry } from '../src/layers/routes/draft';
import { createRouteRemovalResolver } from './helpers/route-removal';
import { compositionAirways, compositionFixes, compositionPreferred, compositionTerminal } from './fixtures/route-composition';
import { identifyRoutePoint } from '../src/layers/routes/identification';
import { parseRouteEntries } from '../src/layers/routes/draft-storage';
import { routeExportText } from '../src/layers/routes/export';
import { directToRoutePoint } from '../src/layers/routes/direct-to';
import { identificationStations } from './fixtures/route-identification';

const resolve = createRouteRemovalResolver();

for (const occurrence of [0, 1]) for (const kind of ['coordinate', 'radial'] as const)
test(`TEC expansion keeps the ${kind} description on repeated visit ${occurrence + 1}`, () => {
  let draft = routeDraftFromText('KSBA LOOP1 KSMX'), plan = resolve(draft);
  const point = plan.waypoints.filter(point => point.ident === 'TAILS')[occurrence]!;
  const station = { ...identificationStations.features[0]!,
    geometry: { type: 'Point' as const, coordinates: [-119.1, 36] as [number, number] } };
  const form = kind === 'coordinate' ? { kind } : radialFormsForPoint(point.feature.geometry.coordinates, [station])[0]!.form;
  draft = identifyRoutePoint(draft, plan, point, form);
  plan = resolve(draft);
  const expanded = expandRouteEntry(draft, plan, draft.entries[1]!.id);
  const restored = parseRouteEntries(JSON.parse(JSON.stringify(expanded.entries)))!;
  assert.ok(restored);
  assert.deepEqual(resolve(restored).waypoints.map(point => point.identification), plan.waypoints.map(point => point.identification));
  assert.equal(restored.entries.filter(entry => entry.identifications?.length).length, 1);
});

test('TEC descriptions stay with repeated airway occurrences through both expansion levels', () => {
  const preferred = { ...compositionPreferred, routes: [{ ...compositionPreferred.routes[0]!,
    route: 'SUNOL V23 EXIT V23 SUNOL', segments: [] }] };
  const airports = compositionAirports();
  const resolve = createRouteResolver([airports, compositionFixes], compositionAirways, undefined, preferred);
  let draft = routeDraftFromText('KSFO BAYT1 KSJC'), plan = resolve(draft);
  draft = identifyRoutePoint(draft, plan, plan.waypoints.filter(point => point.ident === 'MID')[1]!, { kind: 'coordinate' });
  plan = resolve(draft);
  let expanded = expandRouteEntry(draft, plan, draft.entries[1]!.id);
  assert.deepEqual(resolve(expanded).waypoints.map(point => point.identification), plan.waypoints.map(point => point.identification));
  for (const airway of expanded.entries.filter(entry => entry.text === 'V23')) expanded = expandRouteEntry(expanded, resolve(expanded), airway.id);
  assert.deepEqual(resolve(expanded).waypoints.map(point => point.identification), plan.waypoints.map(point => point.identification));
});

function compositionAirports() {
  return { ...compositionFixes, meta: { ...compositionFixes.meta, layer: 'airports' as const },
    features: ['KSFO', 'KSJC'].map((ident, i) => ({ ...compositionFixes.features[i]!, id: ident,
      properties: { ident, icaoId: ident, faaId: ident.slice(1) } })) };
}

test('TEC expansion retains airport aliases that would otherwise select a navaid', () => {
  const navaids = { ...compositionFixes, meta: { ...compositionFixes.meta, layer: 'navaids' as const },
    features: [{ ...compositionFixes.features[0]!, id: 'navaid:SFO', properties: { ident: 'SFO', type: 'VOR/DME' } }] };
  const resolve = createRouteResolver([compositionAirports(), compositionFixes, navaids], undefined, compositionTerminal, compositionPreferred);
  const draft = routeDraftFromText('EXIT SFO BAYT2 SJC START'), plan = resolve(draft);
  assert.deepEqual(plan.issues, []);
  const expanded = expandRouteEntry(draft, plan, draft.entries[2]!.id);
  assert.deepEqual(resolve(expanded).issues, []);
  assert.equal(expanded.entries[1]!.pinnedFeatureId, 'KSFO');
  assert.equal(expanded.entries[1]!.id, draft.entries[1]!.id);
  assert.deepEqual(resolve(expanded).waypoints.map(point => point.feature.id), plan.waypoints.map(point => point.feature.id));
});

test('expanding a TEC between intermediate stops preserves SID/STAR paths, descriptions, export and reload', () => {
  assert.ok(isTerminalProceduresData(compositionTerminal));
  const resolve = createRouteResolver([compositionAirports(), compositionFixes], undefined, compositionTerminal, compositionPreferred);
  let draft = routeDraftFromText('EXIT KSFO BAYT2 KSJC START'), plan = resolve(draft);
  assert.deepEqual(plan.issues, []);
  // MID occurs in both procedures; the STAR's description must not leak to the SID.
  draft = identifyRoutePoint(draft, plan, plan.waypoints.filter(point => point.ident === 'MID')[1]!, { kind: 'coordinate' });
  plan = resolve(draft);
  draft = identifyRoutePoint(draft, plan, plan.waypoints.find(point => point.ident === 'START' && !point.edit)!, { kind: 'coordinate' });
  plan = resolve(draft);
  const expanded = expandRouteEntry(draft, plan, draft.entries[2]!.id);
  const normalized = attachRouteDepartures(expanded, resolve(expanded), compositionTerminal);
  const restored = parseRouteEntries(JSON.parse(JSON.stringify(normalized.entries)))!;
  assert.ok(restored);
  const after = resolve(restored);
  assert.deepEqual(after.issues, []);
  assert.deepEqual(after.waypoints.map(point => [point.feature.id, point.identification]),
    plan.waypoints.map(point => [point.feature.id, point.identification]));
  assert.equal(after.distanceNm, plan.distanceNm);
  assert.equal(routeExportText(after), routeExportText(plan));
  assert.equal(restored.entries[1]!.departure?.ident, 'LOCAL1');
  assert.equal(after.procedures.find(procedure => procedure.kind === 'arrival')?.ident, 'LOCAL2');
  // A direct-to before the intermediate stop must keep its later SID intact.
  const direct = directToRoutePoint(restored, after, after.waypoints[0]!, [-123, 38]);
  assert.equal(direct.entries.find(entry => entry.text === 'KSFO')?.departure?.ident, 'LOCAL1');
  assert.deepEqual(resolve(direct).issues, []);
});

test('a TEC exposes three adjacent airways and expanding the middle one retains both neighbors', () => {
  const airports = { ...compositionFixes, meta: { ...compositionFixes.meta, layer: 'airports' as const },
    features: ['KSFO', 'KSJC'].map((ident, i) => ({ ...compositionFixes.features[i]!, id: ident,
      properties: { ident, icaoId: ident, faaId: ident.slice(1) } })) };
  const airways = { ...compositionAirways, airways: ['V1', 'V2', 'V3'].map((ident, i) => {
    const points = ['START', 'SUNOL', 'MID', 'EXIT'].slice(i, i + 2);
    return { ident, id: ident, points, segments: [{ sequence: 1, from: points[0]!, to: points[1]!, gap: false }] };
  }) };
  const preferred = { ...compositionPreferred, routes: [{ ...compositionPreferred.routes[0]!,
    route: 'START V1 V2 V3 EXIT', segments: [] }] };
  const resolve = createRouteResolver([airports, compositionFixes], airways, undefined, preferred);
  const draft = routeDraftFromText('KSFO BAYT1 KSJC');
  const first = expandRouteEntry(draft, resolve(draft), draft.entries[1]!.id);
  assert.equal(routeDraftText(first), 'KSFO START V1 V2 V3 EXIT KSJC');
  const second = expandRouteEntry(first, resolve(first), first.entries[3]!.id);
  assert.equal(routeDraftText(second), 'KSFO START V1 SUNOL MID V3 EXIT KSJC');
  assert.deepEqual(resolve(second).airways.map(airway => airway.ident), ['V1', 'V3']);
  assert.deepEqual(resolve(second).issues, []);
  assert.deepEqual(resolve(second).waypoints.map(point => point.feature.id), resolve(draft).waypoints.map(point => point.feature.id));
});

test('TEC expansion exposes one level; its airway expands separately with exact waypoint pins', () => {
  const draft = routeDraftFromText('UNKNOWN KSBA TEST1 KSMX CMA');
  const plan = resolve(draft), id = draft.entries[2]!.id;
  const expanded = expandRouteEntry(draft, plan, id);
  assert.equal(routeDraftText(expanded), 'UNKNOWN KSBA ENTRY V1 EXIT KSMX CMA');
  assert.equal(expanded.entries[2]!.id, id);
  const airway = expanded.entries[3]!;
  const next = expandRouteEntry(expanded, resolve(expanded), airway.id);
  assert.equal(routeDraftText(next), 'UNKNOWN KSBA ENTRY TAILS MID EXIT KSMX CMA');
  assert.deepEqual(next.entries.slice(3, 5).map(entry => entry.pinnedFeatureId), ['fix:TAILS', 'fix:MID']);
  assert.deepEqual(resolve(next).waypoints.map(point => point.feature.id), plan.waypoints.map(point => point.feature.id));
  for (const entry of [draft.entries[0], draft.entries[1], draft.entries[3], draft.entries[4]]) {
    assert.equal(next.entries.find(value => value.id === entry!.id), entry);
  }
});

for (const [input, index, expected] of [
  ['ENTRY V1 V2 AFTER', 1, 'ENTRY TAILS MID EXIT V2 AFTER'],
  ['ENTRY V1 V2 AFTER', 2, 'ENTRY V1 EXIT AFTER'],
  ['AFTER V2 V1 ENTRY', 1, 'AFTER EXIT V1 ENTRY'],
  ['AFTER V2 V1 ENTRY', 2, 'AFTER V2 EXIT MID TAILS ENTRY'],
  ['ENTRY V1 EXIT V1 ENTRY', 3, 'ENTRY V1 EXIT MID TAILS ENTRY'],
  ['TAILS V1 MID', 1, 'TAILS MID'],
] as const) test(`expand occurrence ${index} in ${input} while retaining neighboring airways`, () => {
  const draft = routeDraftFromText(input), plan = resolve(draft);
  const expanded = expandRouteEntry(draft, plan, draft.entries[index]!.id);
  assert.equal(routeDraftText(expanded), expected);
  assert.deepEqual(resolve(expanded).issues, []);
  assert.deepEqual(resolve(expanded).waypoints.map(point => point.feature.id), plan.waypoints.map(point => point.feature.id));
  for (const entry of draft.entries.filter((_, i) => i !== index)) assert.ok(expanded.entries.includes(entry));
});

test('incomplete airways, ordinary points and stale actions cannot be expanded', () => {
  for (const missingFix of ['MID', 'ENTRY', 'EXIT']) {
    const resolve = createRouteRemovalResolver({ missingFix });
    const draft = routeDraftFromText('KSBA ENTRY V1 EXIT KSMX'), plan = resolve(draft);
    assert.equal(routeEntryExpansion(plan, draft.entries[2]!.id), undefined);
    assert.equal(expandRouteEntry(draft, plan, draft.entries[2]!.id), draft);
  }
  const draft = routeDraftFromText('KSBA TEST1 KSMX'), plan = resolve(draft);
  assert.equal(routeEntryExpansion(plan, draft.entries[0]!.id), undefined);
  assert.equal(routeEntryExpansion(plan, 'removed'), undefined);
  const changed = removeRouteEntry(draft, draft.entries[0]!.id);
  assert.equal(expandRouteEntry(changed, plan, draft.entries[1]!.id), changed);
});

test('TEC expansion retains typed pins and unresolved children without recursively flattening', () => {
  const airports = { ...compositionFixes, meta: { ...compositionFixes.meta, layer: 'airports' as const },
    features: ['KSFO', 'KSJC'].map((ident, i) => ({ ...compositionFixes.features[i]!, id: ident,
      properties: { ident, icaoId: ident, faaId: ident.slice(1) } })) };
  const resolve = createRouteResolver([airports, compositionFixes], compositionAirways, undefined, compositionPreferred);
  const draft = routeDraftFromText('KSFO BAYT1 KSJC'), plan = resolve(draft);
  const expanded = expandRouteEntry(draft, plan, draft.entries[1]!.id);
  assert.equal(routeDraftText(expanded), 'KSFO VECTORS SUNOL V23 EXIT KSJC');
  assert.deepEqual(expanded.entries.map(entry => entry.pinnedFeatureId), [undefined, undefined, 'fix:SUNOL', undefined, 'fix:EXIT', undefined]);
  assert.deepEqual(resolve(expanded).unresolved, ['VECTORS']);
});
