import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalProceduresData, type FeatureCollectionResponse } from '@zlayer/contracts';
import { createRouteResolver, routeDraftFromText, type RouteApproach } from '@zlayer/domain';
import approaches from '../packages/domain/test/fixtures/approach-maneuvers.json';
import { project, routeSegments } from '../src/layers/terrain/geometry';

test('a planning connection continues the known maneuver and terrain covers both portions', () => {
  const data: unknown = { type: 'ZLayerTerminalProcedures', metadata: {
    effectiveDate: approaches.metadata.effectiveDate, source: approaches.metadata.source }, procedures: [], approaches };
  assert.ok(isTerminalProceduresData(data));
  const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
    meta: { layer: 'airports', revision: '2026-09-03', returned: 1, truncated: false },
    features: [{ type: 'Feature', id: 'KLAN', properties: { ident: 'KLAN' }, geometry: { type: 'Point', coordinates: [-84.59, 42.78] } }] };
  const draft = routeDraftFromText('KLAN');
  const approach: RouteApproach = { kind: 'approach', source: 'cifp', airportId: 'KLAN', procedureId: 'cifp:KLAN:I28L',
    name: 'ILS OR LOC RWY 28L', cycle: '2609', entry: { routeId: 'KLAN:I28L', transitionId: 'vectors', name: 'VTF', effectiveDate: '2026-09-03' } };
  const plan = createRouteResolver([airports], undefined, data)({ entries: [{ ...draft.entries[0]!, approach }] });
  const prefix = plan.terminalPaths![0]!.spans.find(s => s.assumptions.includes('open-termination'))!;
  const connection = plan.planningConnections!.find(c => c.from.ident === 'RW28L')!;
  assert.deepEqual(connection.start, prefix.coordinates.at(-1));
  assert.equal(connection.to.ident, 'UNSUN');
  assert.notDeepEqual(connection.start, connection.from.feature.geometry.coordinates);
  assert.ok(plan.issues.some(i => i.code === 'approach-discontinuity'));
  assert.equal(plan.legs.some(l => l.to.ident === 'UNSUN'), false);
  const segments = routeSegments([plan]);
  assert.ok(segments.some(([a, b]) => JSON.stringify([a, b]) === JSON.stringify([
    project(connection.start!), project(connection.to.feature.geometry.coordinates)])));
  for (const [index, point] of prefix.coordinates.slice(1).entries()) {
    assert.ok(segments.some(([a, b]) => JSON.stringify([a, b]) === JSON.stringify([project(prefix.coordinates[index]!), project(point)])));
  }
});
