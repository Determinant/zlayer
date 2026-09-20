import assert from 'node:assert/strict';
import test from 'node:test';
import { isRouteHistoryData, isRouteHistoryResource } from '../src/index.js';
import { history, resource, revision } from './fixtures/route-history.js';

test('route frequencies must agree with their cycle, manifest, provenance and usage totals', () => {
  assert.equal(isRouteHistoryResource(resource), true);
  assert.equal(isRouteHistoryData(history, revision, resource), true);
  assert.equal(isRouteHistoryData(history, '2026-10-01', resource), false);
  for (const change of [
    { version: 2 }, { countBasis: 'clearances' }, { source: { ...history.source, sha256: 'b'.repeat(64) } },
    { pairs: history.pairs.slice(0, 2) }, { pairs: [history.pairs[0], history.pairs[0], history.pairs[2]] },
    { observationRange: { firstSeen: '2026-01-28', lastSeen: '2026-01-27' } },
  ]) assert.equal(isRouteHistoryData({ ...history, ...change }, revision, resource), false);
  for (const change of [
    { count: 0 }, { count: 9 }, { engineCounts: {} }, { engineCounts: { Piston: 7 } },
    { engineCounts: { Piston: 9, Jet: -1 } }, { firstSeen: '2025-02-30' }, { lastSeen: '2026-02-01' },
  ]) {
    const data = structuredClone(history);
    Object.assign(data.pairs[0]!.routes[0]!, change);
    assert.equal(isRouteHistoryData(data, revision, resource), false, JSON.stringify(change));
  }
  for (const change of [{ bytes: -1 }, { routeCount: 0 }, { compression: 'zstd' },
    { source: { ...resource.source, url: 'javascript:alert(1)' } }]) {
    assert.equal(isRouteHistoryResource({ ...resource, ...change }), false);
  }
});
