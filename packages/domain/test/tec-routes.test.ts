import assert from 'node:assert/strict';
import test from 'node:test';
import type { AirwayDataResponse, FeatureCollectionResponse, NavigationData, PreferredRouteRecord, PreferredRoutesData } from '@zlayer/contracts';
import { createRouteResolver, preferredRouteAirports, preferredRouteFeaturePins, preferredRouteText, routeDraftFromText } from '../src/index.js';

const collection = (layer: FeatureCollectionResponse['meta']['layer'], idents: string[]): FeatureCollectionResponse => ({
  type: 'FeatureCollection', meta: { layer, revision: '2026-09-03', returned: idents.length, truncated: false },
  features: idents.map((ident, i) => ({ type: 'Feature', id: `${layer}:${ident}`,
    geometry: { type: 'Point', coordinates: [-119 + i / 10, 34] },
    properties: layer === 'airports' ? { faaId: ident, icaoId: `K${ident}` } : { ident, state: 'CA', icaoRegion: 'K2' },
  })),
});
const navigation: NavigationData = { airports: collection('airports', ['SNA', 'BUR', 'SMO', 'VNY']),
  navaids: collection('navaids', ['SLI', 'SMO']), fixes: collection('fixes', ['MID', 'POPPR', 'SILEX']) };
const route: PreferredRouteRecord = { id: 'preferred-route:SNA:BUR:TEC:1', originId: 'SNA', destinationId: 'BUR',
  routeType: 'TEC', routeNumber: 1, designator: 'CSTQ1', route: 'SLI V23 POPPR SMO SILEX', altitude: 'PQ40',
  segments: [['SLI', 'NAVAID'], ['V23', 'AIRWAY'], ['POPPR', 'FIX'], ['SMO', 'NAVAID'], ['SILEX', 'FIX']]
    .map(([value, type], i) => ({ sequence: i + 1, value: value!, type: type!, state: 'CA' })),
};
const preferred: PreferredRoutesData = { type: 'ZLayerPreferredRoutes', metadata: { effectiveDate: '2026-09-03', source: 'test' }, routes: [route] };
const airways: AirwayDataResponse = { type: 'ZLayerAirways', metadata: preferred.metadata, airways: [{ id: 'airway:V23', ident: 'V23',
  points: ['SLI', 'MID', 'POPPR'], segments: [
    { sequence: 1, from: 'SLI', to: 'MID', gap: false },
    { sequence: 2, from: 'MID', to: 'POPPR', gap: false },
  ],
}] };
const input = 'KSNA CSTQ1 KBUR';
const resolve = (data = preferred, nav = navigation, airwayData = airways) =>
  createRouteResolver(Object.values(nav), airwayData, undefined, data);

test('scoped expansion preserves entry identity and nested ownership without exposing internal edit targets', () => {
  const draft = routeDraftFromText('MID KSNA CSTQ1 KBUR SILEX');
  const resolver = resolve();
  const plan = resolver(draft);
  const source = draft.entries[2]!;
  const internals = plan.waypoints.filter(point => !point.edit);
  assert.ok(internals.length > 0);
  assert.ok(internals.every(point => point.source.entryId === source.id && point.source.tokenIndex === 2));
  assert.ok(internals.every(point => point.owners.some(owner => owner.kind === 'tec' && owner.source.entryId === source.id)));
  assert.ok(internals.some(point => point.owners.map(owner => owner.kind).join(',') === 'tec,airway'));
  assert.deepEqual(plan.waypoints.flatMap(point => point.edit ? [point.edit.entryId] : []),
    draft.entries.filter(entry => entry !== source).map(entry => entry.id));
  assert.deepEqual(plan.legs.flatMap(leg => leg.edit ? [leg.edit.afterEntryId] : []), [draft.entries[0]!.id, draft.entries[3]!.id]);
  assert.equal(plan.entries, draft.entries, 'the resolver never replaces or modifies draft entries');
  const repeated = resolver(draft);
  assert.notEqual(plan.revision, repeated.revision);
  assert.deepEqual({ ...repeated, revision: plan.revision }, plan);
});

test('TEC text stays compact while its typed points and airways resolve to the published geometry', () => {
  const plan = resolve()(input);
  const pair = preferredRouteAirports(plan.tokens, navigation.airports!.features)!;
  const expanded = createRouteResolver(Object.values(navigation), airways)(preferredRouteText(route, pair)!,
    preferredRouteFeaturePins(route, pair, navigation));
  assert.deepEqual(plan.tokens, ['KSNA', 'CSTQ1', 'KBUR']);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.waypoints.map(point => point.ident), ['KSNA', 'SLI', 'MID', 'POPPR', 'SMO', 'SILEX', 'KBUR']);
  assert.deepEqual(plan.waypoints.map(point => point.feature), expanded.waypoints.map(point => point.feature));
  assert.equal(plan.waypoints.find(point => point.ident === 'SMO')?.layer, 'navaids', 'never choose the same-named airport');
  assert.equal(plan.distanceNm, expanded.distanceNm);
  assert.deepEqual(plan.legs.map(leg => leg.midpoint), expanded.legs.map(leg => leg.midpoint));
  assert.deepEqual(plan.tecRoutes, [{ tokenIndex: 1, route }]);
  assert.deepEqual(plan.airways.map(airway => [airway.ident, airway.tokenIndex]), [['V23', 1]]);
  assert.deepEqual(plan.waypoints.map(point => point.tokenIndex), [0, undefined, undefined, undefined, undefined, undefined, 2]);
  assert.ok(plan.waypoints.slice(1, -1).every(point => point.owners.find(owner => owner.kind === 'tec')?.source.tokenIndex === 1));
  for (const leg of plan.legs) {
    assert.equal((leg.edit ? leg.from.source.tokenIndex : undefined), undefined, 'implicit legs cannot insert tokens into the compact input');
    assert.equal(leg.owners.find(owner => owner.kind === 'tec')?.source.tokenIndex, 1);
    assert.ok(plan.waypoints.includes(leg.from) && plan.waypoints.includes(leg.to));
  }
  assert.deepEqual({ ...resolve()('ksna.dct.cstq1/kbur'), revision: plan.revision }, plan);
  assert.deepEqual({ ...resolve()(input), revision: plan.revision }, plan, 'interpretation never mutates the shared reference data');
});

test('TEC requires its published airport pair and direction, without guessing placement or definitions', () => {
  for (const [text, code] of [
    ['KBUR CSTQ1 KSNA', 'tec-airports'], ['KSNA CSTQ1 KSMO', 'tec-airports'], ['SLI CSTQ1 KBUR', 'tec-airports'],
    ['KSNA CSTQ1 SILEX KBUR', 'tec-airports'], ['CSTQ1 KSNA KBUR', 'tec-placement'],
    ['KSNA KBUR CSTQ1', 'tec-placement'],
  ]) {
    const plan = resolve()(text!);
    const issue = plan.issues.find(issue => issue.code === code);
    assert.ok(issue, text);
    assert.deepEqual(plan.tecRoutes, []);
    assert.equal(plan.legs.some(leg => leg.from.tokenIndex! < issue.tokenIndex && leg.to.tokenIndex! > issue.tokenIndex), false);
  }
  const duplicate = resolve({ ...preferred, routes: [route, { ...route, id: 'variant', altitude: 'J80' }] })(input);
  assert.equal(duplicate.issues[0]?.code, 'tec-ambiguous');
  assert.equal(duplicate.legs.length, 0);
  const nav = structuredClone(navigation);
  nav.airports!.features.push({ ...nav.airports!.features[0]!, id: 'duplicate-airport' });
  assert.equal(resolve(preferred, nav)(input).issues[0]?.code, 'tec-airports');
  assert.deepEqual(resolve(preferred, nav)(input, { 0: 'airports:SNA' }).issues, []);
});

test('unavailable or ambiguous typed waypoints cannot silently lose their published constraints', () => {
  for (const change of ['missing', 'state', 'duplicate'] as const) {
    const nav = structuredClone(navigation);
    const smo = nav.navaids!.features[1]!;
    if (change === 'missing') nav.navaids!.features.pop();
    else if (change === 'state') smo.properties.state = 'NV';
    else nav.navaids!.features.push({ ...smo, id: 'another-SMO' });
    const plan = resolve(preferred, nav)(input);
    assert.equal(plan.issues[0]?.code, 'tec-route-unavailable', change);
    assert.equal(plan.legs.length, 0, change);
    assert.deepEqual(plan.unresolved, ['CSTQ1']);
  }
});

test('incomplete TEC segment metadata leaves a warning and a gap, never an untyped expansion', () => {
  const plan = resolve({ ...preferred, routes: [{ ...route, segments: route.segments.slice(0, -1) }] })(input);
  assert.deepEqual(plan.tokens, ['KSNA', 'CSTQ1', 'KBUR']);
  assert.deepEqual(plan.issues.map(issue => issue.code), ['tec-route-unavailable']);
  assert.deepEqual(plan.unresolved, ['CSTQ1']);
  assert.deepEqual(plan.tecRoutes, []);
  assert.deepEqual(plan.waypoints.map(point => point.ident), ['KSNA', 'KBUR']);
  assert.equal(plan.legs.length, 0);
});

test('internal missing points and airway gaps report against the TEC token without bridging them', () => {
  const nav = structuredClone(navigation);
  nav.fixes!.features.shift();
  const missing = resolve(preferred, nav)(input);
  const broken = structuredClone(airways);
  broken.airways[0]!.segments[0]!.gap = true;
  const gap = resolve(preferred, navigation, broken)(input);
  for (const plan of [missing, gap]) {
    assert.equal(plan.legs.some(leg => leg.from.ident === 'SLI' && leg.to.ident === 'POPPR'), false);
    assert.ok(plan.issues.length > 0);
    assert.ok(plan.issues.every(issue => issue.tokenIndex === 1 && issue.token === 'CSTQ1' && issue.message.startsWith('CSTQ1:')));
    assert.deepEqual(plan.unresolved, ['CSTQ1']);
  }
});

test('direct-only TEC definitions keep the destination at its original editable position', () => {
  for (const segments of [[], [{ sequence: 1, value: 'DCT', type: 'DIRECT' }]]) {
    const plan = resolve({ ...preferred, routes: [{ ...route, route: 'DCT', segments }] })(input);
    assert.deepEqual(plan.waypoints.map(point => point.tokenIndex), [0, 2]);
    assert.equal(plan.legs.length, 1);
    assert.equal(plan.legs[0]!.edit, undefined);
    assert.deepEqual(plan.issues, []);
  }
});

test('older packs leave unknown TEC codes unresolved, while explicit map selections retain their meaning', () => {
  const old = createRouteResolver(Object.values(navigation), airways)(input);
  assert.deepEqual(old.unresolved, ['CSTQ1']);
  assert.equal(old.legs.length, 0);
  const pinned = resolve()(input, { 1: 'fixes:SILEX' });
  assert.deepEqual(pinned.tecRoutes, []);
  assert.deepEqual(pinned.waypoints.map(point => point.ident), ['KSNA', 'SILEX', 'KBUR']);
  assert.deepEqual(pinned.waypoints.map(point => point.tokenIndex), [0, 1, 2]);
});

test('KSNA CSTQ9 KSMO can continue to KVNY without changing the TEC segment', () => {
  // Synthetic geometry: this tests the reported input, not a published routing revision.
  const cstq9 = { ...route, id: 'test:CSTQ9', destinationId: 'SMO', designator: 'CSTQ9' };
  const resolver = resolve({ ...preferred, routes: [cstq9] });
  const segment = resolver('KSNA CSTQ9 KSMO');
  const plan = resolver('KSNA CSTQ9 KSMO KVNY');
  assert.deepEqual(plan.tokens, ['KSNA', 'CSTQ9', 'KSMO', 'KVNY']);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.waypoints.slice(0, -1), segment.waypoints);
  assert.deepEqual(plan.legs.slice(0, -1), segment.legs);
  assert.deepEqual(plan.tecRoutes, segment.tecRoutes);
  const continuation = plan.legs.at(-1)!;
  assert.deepEqual([continuation.from.ident, continuation.to.ident, (continuation.edit ? continuation.from.source.tokenIndex : undefined)], ['KSMO', 'KVNY', 2]);
  assert.equal(continuation.owners.find(owner => owner.kind === 'tec')?.source.tokenIndex, undefined);
  assert.equal(plan.distanceNm, segment.distanceNm + continuation.distanceNm);
  assert.equal(plan.waypoints.at(-1)!.tokenIndex, 3);
  const shortIdents = resolver('SLI SNA CSTQ9 SMO SILEX');
  assert.deepEqual(shortIdents.issues, []);
  assert.deepEqual(shortIdents.waypoints.filter(point => point.tokenIndex === 1 || point.tokenIndex === 3)
    .map(point => point.feature.id), ['airports:SNA', 'airports:SMO'], 'TEC endpoints keep airport identity inside a route');
});

test('ordinary fixes before and after TEC keep their own editable token positions', () => {
  const plan = resolve()('SLI KSNA CSTQ1 KBUR SILEX');
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.tecRoutes, [{ tokenIndex: 2, route }]);
  assert.deepEqual(plan.waypoints.filter(point => point.tokenIndex !== undefined)
    .map(point => [point.ident, point.tokenIndex]), [['SLI', 0], ['KSNA', 1], ['KBUR', 3], ['SILEX', 4]]);
  assert.deepEqual(plan.legs.filter(leg => (leg.edit ? leg.from.source.tokenIndex : undefined) !== undefined).map(leg => (leg.edit ? leg.from.source.tokenIndex : undefined)), [0, 3]);
  assert.ok(plan.legs.slice(1, -1).every(leg => leg.owners.find(owner => owner.kind === 'tec')?.source.tokenIndex === 2 && (leg.edit ? leg.from.source.tokenIndex : undefined) === undefined));
  assert.ok(plan.legs.every(leg => plan.waypoints.includes(leg.from) && plan.waypoints.includes(leg.to)));
});

test('ordinary airways on either side of TEC retain their expansions and attribution', () => {
  const plan = resolve()('SLI V23 POPPR KSNA CSTQ1 KBUR SLI V23 POPPR');
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.airways.map(airway => airway.tokenIndex), [1, 4, 7]);
  assert.deepEqual(plan.waypoints.filter(point => point.ident === 'MID')
    .map(point => [point.owners.find(owner => owner.kind === 'airway')?.source.tokenIndex, point.owners.find(owner => owner.kind === 'tec')?.source.tokenIndex]), [[1, undefined], [4, 4], [7, undefined]]);
  assert.deepEqual(plan.legs.filter(leg => (leg.edit ? leg.from.source.tokenIndex : undefined) !== undefined).map(leg => (leg.edit ? leg.from.source.tokenIndex : undefined)), [2, 5]);
  assert.ok(plan.legs.filter(leg => leg.owners.find(owner => owner.kind === 'airway')?.source.tokenIndex === 1 || leg.owners.find(owner => owner.kind === 'airway')?.source.tokenIndex === 7)
    .every(leg => leg.owners.find(owner => owner.kind === 'tec')?.source.tokenIndex === undefined));
});

test('pins around a TEC expansion preserve explicit selections and ambiguous airport identity', () => {
  const plan = resolve()('PREFIX KSNA CSTQ1 KBUR SUFFIX', { 0: 'fixes:SILEX', 4: 'navaids:SMO' });
  assert.deepEqual(plan.issues, []);
  assert.deepEqual([plan.waypoints[0]!.feature.id, plan.waypoints.at(-1)!.feature.id], ['fixes:SILEX', 'navaids:SMO']);
  assert.equal(plan.waypoints.at(-1)!.tokenIndex, 4);
  const nav = structuredClone(navigation);
  nav.airports!.features.push({ ...nav.airports!.features[0]!, id: 'duplicate-airport' });
  assert.deepEqual(resolve(preferred, nav)('SLI KSNA CSTQ1 KBUR SILEX', { 1: 'airports:SNA' }).issues, []);
});

test('errors outside TEC keep their own tokens and gaps without invalidating a valid TEC', () => {
  const plan = resolve()('UNKNOWN KSNA CSTQ1 KBUR MISSING SILEX');
  assert.deepEqual(plan.issues.map(issue => [issue.tokenIndex, issue.token, issue.code]),
    [[0, 'UNKNOWN', 'waypoint-not-found'], [4, 'MISSING', 'waypoint-not-found']]);
  assert.deepEqual(plan.unresolved, ['UNKNOWN', 'MISSING']);
  assert.deepEqual(plan.tecRoutes, [{ tokenIndex: 2, route }]);
  assert.equal(plan.legs.some(leg => leg.from.ident === 'KBUR' && leg.to.ident === 'SILEX'), false);
});

test('multiple TEC segments share an airport and leave surrounding routes unconstrained', () => {
  const next = { ...route, id: 'test:SECOND', originId: 'BUR', destinationId: 'SMO',
    designator: 'SECOND1', route: 'DCT', segments: [] };
  const plan = resolve({ ...preferred, routes: [route, next] })('SLI KSNA CSTQ1 KBUR SECOND1 KSMO SILEX');
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.tecRoutes.map(tec => tec.tokenIndex), [2, 4]);
  assert.equal(plan.waypoints.filter(point => point.ident === 'KBUR').length, 1);
  assert.deepEqual(plan.legs.filter(leg => (leg.edit ? leg.from.source.tokenIndex : undefined) !== undefined).map(leg => (leg.edit ? leg.from.source.tokenIndex : undefined)), [0, 5]);
  assert.equal(plan.legs.at(-2)!.owners.find(owner => owner.kind === 'tec')?.source.tokenIndex, 4, 'even a direct TEC leg is implicit');
  assert.deepEqual(plan.waypoints.filter(point => point.tokenIndex !== undefined)
    .map(point => point.tokenIndex), [0, 1, 3, 5, 6]);
});

test('one invalid TEC reports its own local airport pair without disabling other segments', () => {
  for (const text of ['KSNA CSTQ1 KBUR CSTQ1 KSMO SILEX', 'KSMO CSTQ1 KSNA CSTQ1 KBUR SILEX']) {
    const plan = resolve()(text);
    const invalid = text.startsWith('KSNA') ? 3 : 1;
    const valid = invalid === 3 ? 1 : 3;
    assert.deepEqual(plan.tecRoutes, [{ tokenIndex: valid, route }]);
    assert.deepEqual(plan.issues.map(issue => [issue.tokenIndex, issue.token, issue.code]), [[invalid, 'CSTQ1', 'tec-airports']]);
    assert.equal(plan.issues[0]!.message.startsWith('CSTQ1: CSTQ1:'), false);
    assert.equal(plan.legs.some(leg => leg.from.tokenIndex === invalid - 1 && leg.to.tokenIndex === invalid + 1), false);
  }
});
