import assert from 'node:assert/strict';
import test from 'node:test';
import clipping, { type MultiPolygon } from 'polygon-clipping';
import type { Bounds, CatalogResponse } from '@zlayer/contracts';
import type { SavedBundle } from '../src/offline/bundle-repository';
import { OFFLINE_REGIONS } from '../src/offline/regions';
import { partitionRegionCoverage, regionCoverage, uniformRectangleCoverage, worldPoint, type RegionCoverage } from '../src/offline/region-coverage';

const catalog: CatalogResponse = { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-03T00:00:00Z',
  charts: [], weather: [], navigation: [] };
const saved = (id: string, bounds: Bounds[] = []): SavedBundle => ({ catalog, key: id, bounds,
  plan: { id, regionId: id, title: id, revision: catalog.revision, files: [], references: [] } });
const rectangle = ([west, south, east, north]: Bounds): MultiPolygon => {
  const [left, top] = worldPoint([west, north]), [right, bottom] = worldPoint([east, south]);
  return [[[[left, top], [right, top], [right, bottom], [left, bottom], [left, top]]]];
};

// Independent oracle: always apply the original full polygon operations, with
// no containment shortcut or extent pruning. Inputs here are unwrapped views.
function reference(bundles: readonly SavedBundle[], bounds: Bounds): RegionCoverage[] {
  // Match the established wrapped-world coordinate normalization even for
  // ordinary longitudes; its floating-point rounding is part of the input.
  const west = ((bounds[0] + 180) % 360 + 360) % 360 - 180;
  let remaining = rectangle([west, bounds[1], west + (bounds[2] - bounds[0]), bounds[3]]);
  const parts: RegionCoverage[] = [];
  for (const bundle of bundles) {
    if (!remaining.length) break;
    const geometry = clipping.intersection(remaining, regionCoverage(bundle.plan.regionId, bundle.bounds));
    if (!geometry.length) continue;
    parts.push({ bundle, geometry });
    remaining = clipping.difference(remaining, geometry);
  }
  if (remaining.length) parts.push({ geometry: remaining });
  return parts;
}

function equivalent(actual: RegionCoverage[], expected: RegionCoverage[]) {
  assert.deepEqual(actual.map(p => p.bundle), expected.map(p => p.bundle), 'same owners in precedence order');
  for (let i = 0; i < actual.length; i++) {
    assert.deepEqual(clipping.xor(actual[i]!.geometry, expected[i]!.geometry), [], 'identical covered area, including holes');
  }
}

test('uniform interior and exterior ownership avoid clipping, including partially claimed rectangles', t => {
  const operations = [t.mock.method(clipping, 'intersection'), t.mock.method(clipping, 'difference')];
  const ca = saved('us-CA');
  const inside: Bounds = [-122.2, 37.3, -122.1, 37.4];
  assert.equal(partitionRegionCoverage([ca], inside)[0]!.bundle, ca);
  // Reno lies inside California's outer polygon extent, but outside its border.
  assert.equal(partitionRegionCoverage([ca], [-119.8, 39.4, -119.7, 39.6])[0]!.bundle, undefined);
  assert.deepEqual(operations.map(op => op.mock.callCount()), [0, 0]);

  const island = saved('island', [[-2, -2, 2, 2]]), background = saved('background', [[-20, -20, 20, 20]]);
  const view: Bounds = [-10, -10, 10, 10];
  const result = partitionRegionCoverage([island, background], view);
  assert.deepEqual(result.map(part => part.bundle), [island, background]);
  assert.equal(result[1]!.geometry[0]!.length, 2, 'earlier edition remains a hole in the later edition');
  assert.deepEqual(operations.map(op => op.mock.callCount()), [1, 1], 'only the actual island boundary needs polygon operations');
  t.mock.restoreAll();
  equivalent(result, reference([island, background], view));
});

test('enclosed islands, gaps, concave unions and touching edges retain exact ownership', () => {
  const frame = saved('frame', [[-10, -10, -5, 10], [5, -10, 10, 10], [-10, -10, 10, -5], [-10, 5, 10, 10]]);
  const island = saved('island', [[-1, -1, 1, 1]]);
  const fill = saved('fill', [[-20, -20, 20, 20]]);
  for (const bundles of [[frame], [frame, island], [island, frame, fill], [fill, frame, island]]) {
    for (const view of [
      [-8, -8, 8, 8], // All corners lie in the frame, but its central gap must remain.
      [-2, -2, 2, 2], // An island is enclosed even though no corner lies on it.
      [2, 2, 3, 3], // Entirely in the frame's gap.
      [-6, -6, 6, 6], [-12, -2, 0, 2], [-10, -10, -5, 10],
      [10, -2, 12, 2], [-11, -2, -10, 2], // Edge-only contact has no area.
    ] as Bounds[]) equivalent(partitionRegionCoverage(bundles, view), reference(bundles, view));
  }
});

test('uniform classification rejects enclosed holes, islands and concave boundaries', () => {
  const outer: MultiPolygon = [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
    [[.4, .4], [.6, .4], [.6, .6], [.4, .6], [.4, .4]]]];
  assert.equal(uniformRectangleCoverage(outer, [.1, .1, .2, .2]), true);
  assert.equal(uniformRectangleCoverage(outer, [.45, .45, .55, .55]), false, 'inside a hole');
  assert.equal(uniformRectangleCoverage(outer, [.3, .3, .7, .7]), undefined, 'all corners covered, but a hole is enclosed');
  assert.equal(uniformRectangleCoverage([[outer[0]![1]!]], [.3, .3, .7, .7]), undefined, 'all corners outside, but an island is enclosed');
  const concave: MultiPolygon = [[[[0, 0], [1, 0], [1, 1], [.6, 1], [.6, .4], [.4, .4], [.4, 1], [0, 1], [0, 0]]]];
  assert.equal(uniformRectangleCoverage(concave, [.2, .5, .8, .8]), undefined, 'covered corners cannot hide a gap');
  assert.equal(uniformRectangleCoverage(outer, [0, .1, .2, .2]), undefined, 'touching an edge stays on the exact path');
  assert.equal(uniformRectangleCoverage(outer, [.1, .1, .1, .2]), undefined, 'degenerate rectangles stay on the exact path');
});

test('real borders and islands match full clipping across zooms and saved precedence', () => {
  const regions = ['CA', 'NV', 'AK', 'MI', 'GU', 'PR'].map(code => {
    const region = OFFLINE_REGIONS.find(region => region.code === code)!;
    return saved(region.id, region.bounds);
  });
  const centers = [[-122.15, 37.35], [-120.005, 39.4], [-119.7681, 39.4991], [-119.5, 38.5],
    [-120.05, 34.02], [-149.99, 61.17], [173.18, 52.83], [-166.5, 53.9], [-85.5, 45.5],
    [144.8, 13.49], [-66, 18.44]];
  for (const bundles of [regions, [...regions].reverse()]) {
    for (const [x, y] of centers) for (const span of [.002, .1, 1]) {
      const view: Bounds = [x! - span, y! - span, x! + span, y! + span];
      equivalent(partitionRegionCoverage(bundles, view), reference(bundles, view));
    }
  }
});
