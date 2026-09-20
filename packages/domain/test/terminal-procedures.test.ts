import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isTerminalProceduresData, type FeatureCollectionResponse, type PreferredRoutesData, type TerminalProceduresData } from '@zlayer/contracts';
import { createRouteResolver } from '../src/route.js';

const data: unknown = JSON.parse(readFileSync(new URL('../../contracts/test/fixtures/terminal-procedures.json', import.meta.url), 'utf8'));
assert.ok(isTerminalProceduresData(data));
const terminal = data;
const input = 'KSJC SPTNS1 VLREE EBAYE BURGL ELLBC OHSEA3 KSNA';
const expected = ['KSJC', 'SPTNS', 'TECKY', 'VLREE', 'EBAYE', 'BURGL', 'ELLBC', 'GOONA', 'GUDBY',
  'YORBS', 'PCIFC', 'CRAYN', 'SIPPP', 'TANDY', 'OHSEA', 'STYFF', 'KSNA'];
const points = [...new Map(terminal.procedures.flatMap(procedure => procedure.routes.flatMap(route => route.points))
  .map(point => [point.ident, point])).values(), ...['EBAYE', 'BURGL'].map(ident => ({ ident, type: 'WP' }))];
const collection = (layer: 'airports' | 'fixes' | 'navaids', features: FeatureCollectionResponse['features']): FeatureCollectionResponse => ({
  type: 'FeatureCollection', meta: { layer, revision: '2026-09-03', returned: features.length, truncated: false }, features,
});
const navigation = [collection('airports', ['SJC', 'SNA', 'SFO'].map((faaId, i) => ({
  type: 'Feature', id: `airport:${faaId}`, geometry: { type: 'Point', coordinates: [-122 + i, 37] }, properties: { faaId, icaoId: `K${faaId}` },
}))), collection('fixes', points.map((point, i) => ({
  type: 'Feature', id: `fix:${point.ident}`, geometry: { type: 'Point', coordinates: [-122 + i / 10, 36] },
  properties: { ident: point.ident, useCode: point.type, icaoRegion: 'K2' },
})))];
const resolve = (data: TerminalProceduresData = terminal, collections = navigation) => createRouteResolver(collections, undefined, data);

test('expands the filed SID and STAR transitions, showing shared branches without choosing runways', () => {
  const plan = resolve()(input);
  assert.deepEqual(plan.waypoints.map(point => point.ident), expected);
  assert.deepEqual(plan.procedures.map(procedure => [procedure.ident, procedure.transition, procedure.partial]),
    [['SPTNS1', 'VLREE', true], ['OHSEA3', 'ELLBC', true]]);
  assert.deepEqual(plan.issues.map(issue => issue.code), ['procedure-branch', 'procedure-branch']);
  assert.equal(plan.legs.some(leg => leg.from.ident === 'KSJC' || leg.to.ident === 'KSNA'), false);
  assert.ok(plan.legs.filter(leg => leg.owners.find(owner => owner.kind === 'procedure')?.source.tokenIndex !== undefined).every(leg => (leg.edit ? leg.from.source.tokenIndex : undefined) === undefined));
  assert.deepEqual(plan.legs.filter(leg => (leg.edit ? leg.from.source.tokenIndex : undefined) !== undefined).map(leg => (leg.edit ? leg.from.source.tokenIndex : undefined)), [2, 3, 4]);
  assert.deepEqual({ ...resolve()(input.replace('SPTNS1 VLREE', 'SPTNS1.VLREE').replace('ELLBC OHSEA3', 'ELLBC.OHSEA3')), revision: plan.revision }, plan);
  assert.deepEqual({ ...resolve()(input), revision: plan.revision }, plan, 'expansion must not mutate shared procedure data');
});

test('wrong airport, misplaced procedure and incompatible transitions do not create false connections', () => {
  for (const route of [input.replace('KSJC', 'KSFO'), input.replace('VLREE', 'BURGL'),
    'SPTNS1 KSJC VLREE', 'KSJC EBAYE SPTNS1 VLREE KSNA', input.replace('ELLBC', 'BURGL')]) {
    const plan = resolve()(route);
    assert.ok(plan.issues.some(issue => issue.code === 'procedure-placement' || issue.code === 'procedure-transition'), route);
    for (const issue of plan.issues.filter(issue => issue.code === 'procedure-placement' || issue.code === 'procedure-transition')) {
      const before = plan.tokens[issue.tokenIndex - 1], after = plan.tokens[issue.tokenIndex + 1];
      assert.equal(plan.legs.some(leg => leg.from.ident === before && leg.to.ident === after), false, route);
    }
  }
});

test('procedure airport matching respects a direct navaid identifier and explicit airport selections', () => {
  const navaids = collection('navaids', ['SJC', 'SNA'].map(ident => ({
    type: 'Feature', id: `navaid:${ident}`, geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { ident, type: 'VOR/DME' },
  })));
  const resolver = resolve(terminal, [...navigation, navaids]);
  for (const [airport, procedure, tokenIndex] of [['SJC', 'SPTNS1', 0], ['SNA', 'OHSEA3', 7]] as const) {
    const text = input.replace(`K${airport}`, airport);
    const plan = resolver(text);
    assert.equal(plan.waypoints.find(point => point.tokenIndex === tokenIndex)?.feature.id, `navaid:${airport}`);
    assert.ok(plan.issues.some(issue => issue.token === procedure && issue.code === 'procedure-placement'));
    const pinned = resolver(text, { [tokenIndex]: `airport:${airport}` });
    assert.equal(pinned.waypoints.find(point => point.tokenIndex === tokenIndex)?.feature.id, `airport:${airport}`);
    assert.equal(pinned.procedures.length, 2);
  }
});

test('missing, wrong-region, wrong-type and incorrectly pinned procedure points leave visible gaps', () => {
  for (const change of ['missing', 'region', 'type'] as const) {
    const collections = structuredClone(navigation);
    const features = collections[1]!.features;
    const index = features.findIndex(feature => feature.properties.ident === 'GOONA');
    if (change === 'missing') features.splice(index, 1);
    else features[index]!.properties[change === 'region' ? 'icaoRegion' : 'useCode'] = 'INVALID';
    const plan = resolve(terminal, collections)(input);
    assert.ok(plan.issues.some(issue => issue.code === 'procedure-point-unavailable'));
    assert.equal(plan.legs.some(leg => leg.from.ident === 'ELLBC' && leg.to.ident === 'GUDBY'), false);
  }
  const plan = resolve()(input, { 2: 'fix:BURGL' });
  assert.ok(plan.issues.some(issue => issue.token === 'SPTNS1' && issue.code === 'procedure-point-unavailable'));
  assert.equal(plan.legs.some(leg => leg.from.ident === 'TECKY' && leg.to.ident === 'BURGL'), false);
});

test('source gaps, absent airport associations and uncoded/vector-only paths are never bridged', () => {
  const gap = structuredClone(terminal);
  const transition = gap.procedures[1]!.routes.find(route => route.kind === 'transition')!;
  delete transition.points[1]!.next;
  const plan = resolve(gap)(input);
  assert.equal(plan.legs.some(leg => leg.from.ident === 'GOONA' && leg.to.ident === 'GUDBY'), false);
  assert.ok(plan.issues.some(issue => issue.message.includes('discontinuity')));
  const missing = structuredClone(terminal);
  for (const route of missing.procedures[0]!.routes) route.airports = [];
  assert.ok(resolve(missing)(input).issues.some(issue => issue.token === 'SPTNS1' && issue.code === 'procedure-transition'));
  missing.procedures[0]!.routes = [];
  assert.ok(resolve(missing)(input).issues.some(issue => issue.token === 'SPTNS1' && issue.code === 'procedure-transition'));
});

test('older packs still resolve enroute points without pretending procedures are direct legs', () => {
  const plan = createRouteResolver(navigation)(input);
  assert.deepEqual(plan.procedures, []);
  assert.deepEqual(plan.unresolved, ['SPTNS1', 'OHSEA3']);
  assert.deepEqual(plan.legs.map(leg => [leg.from.ident, leg.to.ident]), [['VLREE', 'EBAYE'], ['EBAYE', 'BURGL'], ['BURGL', 'ELLBC']]);
});

test('procedures outside a TEC segment retain normal routing and original token positions', () => {
  const preferred: PreferredRoutesData = { type: 'ZLayerPreferredRoutes', metadata: terminal.metadata, routes: [{
    id: 'test:TEC', routeType: 'TEC', routeNumber: 1, originId: 'SNA', destinationId: 'SFO',
    designator: 'TEST1', route: 'EBAYE BURGL', segments: [],
  }] };
  const plan = createRouteResolver(navigation, undefined, terminal, preferred)(
    'KSJC SPTNS1 VLREE KSNA TEST1 KSFO ELLBC OHSEA3 KSNA');
  const expanded = resolve()('KSJC SPTNS1 VLREE KSNA EBAYE BURGL KSFO ELLBC OHSEA3 KSNA');
  assert.deepEqual(plan.waypoints.map(point => point.feature), expanded.waypoints.map(point => point.feature));
  assert.equal(plan.distanceNm, expanded.distanceNm);
  assert.deepEqual(plan.procedures.map(procedure => procedure.tokenIndex), [1, 7]);
  assert.deepEqual(plan.issues.map(issue => [issue.tokenIndex, issue.code]), [[1, 'procedure-branch'], [7, 'procedure-branch']]);
  assert.ok(plan.waypoints.filter(point => point.owners.find(owner => owner.kind === 'procedure')?.source.tokenIndex !== undefined)
    .every(point => point.owners.find(owner => owner.kind === 'tec')?.source.tokenIndex === undefined));
});

test('procedures inside a TEC segment still use its local airports when the route continues', () => {
  const preferred: PreferredRoutesData = { type: 'ZLayerPreferredRoutes', metadata: terminal.metadata, routes: [{
    id: 'test:TEC', routeType: 'TEC', routeNumber: 1, originId: 'SJC', destinationId: 'SNA',
    designator: 'TEST1', route: 'SPTNS1 VLREE EBAYE BURGL ELLBC OHSEA3', segments: [],
  }] };
  const resolver = createRouteResolver(navigation, undefined, terminal, preferred);
  const segment = resolver('KSJC TEST1 KSNA');
  const plan = resolver('EBAYE KSJC TEST1 KSNA BURGL');
  assert.deepEqual(plan.waypoints.slice(1, -1).map(point => point.feature), segment.waypoints.map(point => point.feature));
  assert.deepEqual(plan.procedures.map(procedure => [procedure.ident, procedure.tokenIndex]), [['SPTNS1', 2], ['OHSEA3', 2]]);
  assert.deepEqual(plan.issues.map(issue => [issue.tokenIndex, issue.token, issue.code]),
    [[2, 'TEST1', 'procedure-branch'], [2, 'TEST1', 'procedure-branch']]);
  assert.deepEqual(plan.legs.filter(leg => (leg.edit ? leg.from.source.tokenIndex : undefined) !== undefined).map(leg => (leg.edit ? leg.from.source.tokenIndex : undefined)), [0, 3]);
});
