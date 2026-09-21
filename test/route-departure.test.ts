import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalProceduresData, type FeatureCollectionResponse, type TerminalProceduresData } from '@zlayer/contracts';
import { attachRouteDepartures, createRouteResolver, departureBranches, departureExits, routeDraftFromText, routeDraftText,
  type RouteDeparture } from '@zlayer/domain';
import rawTerminal from './fixtures/route-departures.json';
import { departureNavigation } from './fixtures/route-departure-navigation';
import { moveRouteEntry, removeRouteEntry, replaceRouteText, setRouteDeparture } from '../src/layers/routes/draft';
import { parseRouteEntries } from '../src/layers/routes/draft-storage';
import { routeExportText } from '../src/layers/routes/export';
import { directToRoutePoint } from '../src/layers/routes/direct-to';
import { removeRoutePoint } from '../src/layers/routes/removal';
import { editSavedDraft, savedRoute, changeRouteStash, readRouteStash } from '../src/layers/routes/stash';

assert.ok(isTerminalProceduresData(rawTerminal));
const terminal: TerminalProceduresData = rawTerminal;
const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
  meta: { layer: 'airports', revision: '2026-09-03', returned: 2, truncated: false },
  features: ['SFO', 'SJC'].map((faaId, i) => ({ type: 'Feature', id: `airport:${faaId}`,
    properties: { faaId, icaoId: `K${faaId}` }, geometry: { type: 'Point', coordinates: [-122.375 + i * .5, 37.619] } })),
};
const resolve = createRouteResolver([airports, departureNavigation], undefined, terminal);
const procedure = terminal.procedures[0]!;
const branches = departureBranches(procedure, 'SFO');
const selection = (runway: string): RouteDeparture => {
  const branch = branches.find(branch => branch.id.endsWith(`:${runway}`))!;
  return { kind: 'departure' as const, source: 'nasr' as const, airportId: 'SFO', procedureId: procedure.id, ident: procedure.ident, name: procedure.name,
    effectiveDate: terminal.metadata.effectiveDate, branchId: branch.id, branchName: branch.name, transition: 'DEDHD' };
};
const draft = (runway = '01L', text = 'KSFO KSJC') => {
  const original = routeDraftFromText(text, { 0: 'airport:SFO' });
  return setRouteDeparture(original, original.entries[0]!, selection(runway));
};

test('SID selection retains one airport anchor, expands the selected branch and connects its exit to the next entry', () => {
  for (const runway of ['01L', '01R', '28L', '28R']) {
    const original = draft(runway), plan = resolve(original);
    assert.deepEqual(plan.entries, original.entries);
    assert.deepEqual(plan.tokens, ['KSFO', 'KSJC']);
    assert.deepEqual(plan.waypoints.map(point => point.ident), runway.startsWith('01')
      ? ['KSFO', 'TYDYE', 'TRUKN', 'DEDHD', 'KSJC'] : ['KSFO', 'TRUKN', 'DEDHD', 'KSJC']);
    assert.deepEqual(plan.issues, []);
    assert.equal(plan.procedures[0]!.partial, false);
    assert.equal(plan.waypoints[0]!.edit?.entryId, original.entries[0]!.id);
    assert.equal(plan.legs.some(leg => leg.from.ident === 'KSFO'), false);
    assert.equal(plan.legs.at(-1)!.edit?.afterEntryId, original.entries[0]!.id);
    assert.ok(plan.waypoints.slice(1, -1).every(point => !point.edit && point.source.entryId === original.entries[0]!.id));
    for (const format of ['skyvector', 'foreflight', 'icao'] as const) assert.equal(routeExportText(plan, format), 'KSFO TRUKN2 DEDHD KSJC');
  }
  assert.deepEqual(departureExits(procedure, branches[0]!), ['TRUKN', 'DEDHD', 'GRTFL', 'MOGEE', 'ORRCA', 'SYRAH', 'TIPRE']);
  assert.deepEqual(departureBranches(procedure, 'SJC'), []);
});

test('pasted SID tokens attach to their airport without selecting a runway or duplicating the explicit exit', () => {
  const original = routeDraftFromText('KSFO TRUKN2.DEDHD KSJC');
  const normalized = attachRouteDepartures(original, resolve(original), terminal);
  assert.equal(routeDraftText(normalized), 'KSFO DEDHD KSJC');
  assert.equal(normalized.entries[0]!.id, original.entries[0]!.id);
  assert.equal(normalized.entries[1], original.entries[2]);
  const plan = resolve(normalized);
  assert.deepEqual(plan.waypoints.map(point => point.ident), ['KSFO', 'TRUKN', 'DEDHD', 'KSJC']);
  assert.equal(plan.issues[0]!.code, 'procedure-branch');
  assert.equal(attachRouteDepartures(normalized, plan, terminal), normalized);
  const selected = setRouteDeparture(normalized, normalized.entries[0]!, selection('01L'));
  assert.deepEqual(resolve(selected).issues, []);
  assert.equal(routeExportText(resolve(selected)), 'KSFO TRUKN2 DEDHD KSJC');
  assert.equal(resolve(selected).waypoints.filter(point => point.ident === 'DEDHD').length, 1);
});

test('an attached SID works at an intermediate airport and never silently substitutes an unavailable branch, edition or airport', () => {
  const original = routeDraftFromText('KSJC KSFO KSJC');
  const selected = setRouteDeparture(original, original.entries[1]!, selection('01L'));
  assert.deepEqual(resolve(selected).issues, []);
  for (const bad of [{ ...selection('01L'), branchId: 'missing' }, { ...selection('01L'), airportId: 'SJC' },
    { ...selection('01L'), effectiveDate: '2026-08-06' }, { ...selection('01L'), procedureId: 'missing' }]) {
    const plan = resolve(setRouteDeparture(original, original.entries[1]!, bad));
    assert.ok(plan.issues.some(issue => issue.code === 'procedure-branch'));
    assert.equal(plan.legs.some(leg => leg.from.ident === 'KSFO'), false);
    assert.equal(plan.waypoints.some(point => point.ident === 'TYDYE'), false);
  }
  const unavailable = createRouteResolver([airports, departureNavigation])(draft());
  assert.ok(unavailable.issues.some(issue => issue.code === 'procedure-branch'));
  assert.equal(unavailable.legs.some(leg => leg.from.ident === 'KSFO'), false);
  const missingFix = createRouteResolver([airports, { ...departureNavigation,
    features: departureNavigation.features.filter(feature => feature.properties.ident !== 'TRUKN') }], undefined, terminal)(draft());
  assert.ok(missingFix.issues.some(issue => issue.code === 'procedure-point-unavailable'));
  assert.equal(missingFix.legs.some(leg => leg.from.ident === 'TYDYE' && leg.to.ident === 'DEDHD'), false);
  const reordered = structuredClone(terminal);
  reordered.procedures[0]!.routes.reverse();
  const retained = createRouteResolver([airports, departureNavigation], undefined, reordered)(draft());
  assert.deepEqual(retained.issues, []);
  assert.deepEqual(retained.waypoints.map(point => point.ident), resolve(draft()).waypoints.map(point => point.ident));
});

test('a selected SID supplies an airway entry without adding a separate editable exit', () => {
  const withAirway = createRouteResolver([airports, departureNavigation], {
    type: 'ZLayerAirways', metadata: terminal.metadata, airways: [{ id: 'test:V1', ident: 'V1', points: ['DEDHD', 'GRTFL'],
      segments: [{ sequence: 1, from: 'DEDHD', to: 'GRTFL', gap: false }] }],
  }, terminal);
  const original = draft('01L', 'KSFO V1 GRTFL KSJC'), plan = withAirway(original);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.waypoints.map(point => point.ident), ['KSFO', 'TYDYE', 'TRUKN', 'DEDHD', 'GRTFL', 'KSJC']);
  assert.equal(plan.airways[0]!.entry, 'DEDHD');
  assert.equal(plan.airways[0]!.tokenIndex, 1);
  assert.equal(routeExportText(plan), 'KSFO TRUKN2 DEDHD V1 GRTFL KSJC');
});

test('airport attachment survives reorder and stash/reload, detaches cleanly, and rejects stale picker/map edits', () => {
  const original = draft(), airport = original.entries[0]!;
  assert.deepEqual(parseRouteEntries(JSON.parse(JSON.stringify(original.entries))), original);
  const storage = { value: null as string | null, getItem() { return this.value; }, setItem(_key: string, value: string) { this.value = value; } };
  changeRouteStash(() => [savedRoute('Departure', original)], storage);
  assert.deepEqual(readRouteStash(storage)[0]!.draft, original);
  assert.equal(editSavedDraft(original, 'KSFO UNKNOWN KSJC').entries[0], airport);
  const moved = moveRouteEntry(original, airport.id, original.entries[1]!.id);
  assert.equal(moved.entries[1], airport);
  assert.equal(setRouteDeparture(original, airport, { ...airport.departure! }), original);
  const detached = setRouteDeparture(original, airport, undefined);
  assert.equal(detached.entries[0]!.departure, undefined);
  assert.equal(detached.entries[0]!.pinnedFeatureId, airport.pinnedFeatureId);
  assert.equal(replaceRouteText(original, airport.id, 'KSJC').entries[0]!.departure, undefined);
  assert.equal(setRouteDeparture(detached, airport, selection('28L')), detached);
  assert.equal(removeRouteEntry(original, airport.id).entries.some(entry => entry.departure), false);
  const plan = resolve(original), child = plan.waypoints.find(point => point.ident === 'TYDYE')!;
  assert.deepEqual(removeRoutePoint(original, plan, plan.waypoints.at(-1)!).entries, [airport]);
  assert.equal(removeRoutePoint(original, plan, child), original);
  assert.equal(directToRoutePoint(detached, plan, child, [-123, 38]), detached);
  const direct = directToRoutePoint(original, plan, child, [-123, 38]);
  assert.deepEqual(direct.entries.slice(1).map(entry => entry.text), ['TYDYE', 'TRUKN', 'DEDHD', 'KSJC']);
  assert.equal(direct.entries.some(entry => entry.departure), false);
});
