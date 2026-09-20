import assert from 'node:assert/strict';
import test from 'node:test';
import { isPreferredRoutesData, isPreferredRoutesResource, type PreferredRoutesData } from '../src/index.js';

const data: PreferredRoutesData = {
  type: 'ZLayerPreferredRoutes', metadata: { effectiveDate: '2026-09-03', source: 'FAA NASR' },
  routes: [{ id: 'preferred-route:SBA:SMO:TEC:4', originId: 'SBA', destinationId: 'SMO',
    routeType: 'TEC', routeNumber: 4, altitude: 'PQ70', route: 'KWANG CMA VNY V186 DARTS',
    segments: [{ sequence: 5, value: 'KWANG', type: 'FIX' }] }],
};

test('preferred-route contract accepts coded conditions and rejects wrong cycles or corrupt variants', () => {
  assert.ok(isPreferredRoutesData(data, '2026-09-03'));
  assert.equal(isPreferredRoutesData(data, '2026-10-01'), false);
  assert.equal(isPreferredRoutesData({ ...data, routes: [...data.routes, ...data.routes] }), false);
  for (const change of [{ id: 'wrong' }, { altitude: 7000 }, { route: 123 }, { routeNumber: 0 },
    { segments: [{ sequence: 5, value: 'KWANG', type: 'FIX' }, { sequence: 5, value: 'CMA', type: 'NAVAID' }] }]) {
    assert.equal(isPreferredRoutesData({ ...data, routes: [{ ...data.routes[0], ...change }] }), false);
  }
  assert.ok(isPreferredRoutesData({ ...data, routes: [{ ...data.routes[0], route: undefined, segments: [] }] }));
  assert.equal(isPreferredRoutesData({ ...data, metadata: { ...data.metadata, effectiveDate: '2026-02-30' } }), false);
});

test('preferred route resources validate count and identity', () => {
  const resource = { id: 'preferred-routes', title: 'Routes', url: '/nav/preferred-routes.json', count: 1, sourceCount: 1 };
  assert.ok(isPreferredRoutesResource(resource));
  assert.equal(isPreferredRoutesResource({ ...resource, count: 2 }), false);
  assert.equal(isPreferredRoutesResource({ ...resource, id: 'airways' }), false);
});
