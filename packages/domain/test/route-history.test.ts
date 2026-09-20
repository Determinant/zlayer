import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteHistoryLookup, filedRouteText } from '../src/index.js';
import { readFileSync } from 'node:fs';
import type { RouteHistoryData } from '@zlayer/contracts';
const { history } = JSON.parse(readFileSync(new URL('../../../test/fixtures/route-history.json', import.meta.url), 'utf8')) as { history: RouteHistoryData };

const query = { origins: ['KSBA', 'SBA', 'KSBA'], destinations: ['KSMO', 'SMO'] };
test('directional route frequencies merge airport aliases and equivalent direct routes without double counting', () => {
  const lookup = createRouteHistoryLookup(history.pairs);
  const all = lookup(query);
  assert.deepEqual(all.routes.map(({ route, count }) => [route, count]), [
    ['KSBA KSMO', 11], ['KSBA SBAP12 KSMO', 4], ['KSBA KWANG CMA VNY V186 DARTS KSMO', 2],
  ]);
  assert.equal(all.totalCount, 17);
  assert.deepEqual(all.engines, ['Jet', 'Piston']);
  const piston = lookup({ ...query, engine: 'Piston' });
  assert.deepEqual(piston.routes.map(route => route.count), [9, 4]);
  assert.equal(piston.totalCount, 13);
  assert.deepEqual(piston.engines, all.engines);
  assert.deepEqual(lookup({ ...query, engine: 'Turboprop' }).routes, []);
  assert.equal(lookup({ origins: ['KSMO'], destinations: ['KSBA'] }).totalCount, 7);
  assert.equal(lookup({ origins: ['KSBA'], destinations: ['KJFK'] }).totalCount, 0);
});

test('filed-route imports retain procedure identifiers and normalize route separators', () => {
  assert.equal(filedRouteText('SBA..KWANG.CMA.VNY.V186.DARTS..SMO', query), 'KSBA KWANG CMA VNY V186 DARTS KSMO');
  assert.equal(filedRouteText('SBAP12', query), 'KSBA SBAP12 KSMO');
  assert.equal(filedRouteText('DCT', query), 'KSBA KSMO');
});
