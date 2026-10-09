import assert from 'node:assert/strict';
import test from 'node:test';
import { isAwcAdvisorySnapshot, isWeatherGeometry } from '@zlayer/contracts';
import { normalizeAdvisories } from '../src/layers/weather-awc/source';
import { prepareAdvisoryGeometry } from '../src/layers/weather-awc/source-geometry';
import captured from './fixtures/cwa-dateline-2026-10-08.json' with { type: 'json' };
import openRing from './fixtures/cwa-open-ring-2026-10-09.json' with { type: 'json' };

const normalizeAdvisoryGeometry = (value: unknown) => prepareAdvisoryGeometry(value).geometry;

const ringArea = (ring: number[][]) => Math.abs(ring.slice(1).reduce((sum, p, i) =>
  sum + ring[i]![0]! * p[1]! - p[0]! * ring[i]![1]!, 0)) / 2;
function area(geometry: ReturnType<typeof normalizeAdvisoryGeometry>): number {
  assert.ok(geometry.type === 'Polygon' || geometry.type === 'MultiPolygon');
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((sum, rings) => sum + ringArea(rings[0]!) - rings.slice(1).reduce((a, r) => a + ringArea(r), 0), 0);
}

test('captured Alaska CWA normalizes across the date line without losing any of its seven source entries', () => {
  const before = structuredClone(captured.collection);
  const snapshot = normalizeAdvisories('cwa', [captured.collection], captured.checkedAt, captured.source);
  assert.ok(isAwcAdvisorySnapshot(snapshot));
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.advisories.length, 7); assert.equal(snapshot.issues, undefined);
  assert.deepEqual(captured.collection, before, 'source evidence is immutable');
  for (const [i, notice] of snapshot.advisories.entries()) {
    const raw = before.features[i]!;
    assert.deepEqual(notice.sourceProperties, raw.properties);
    assert.equal(notice.text, raw.properties.cwaText);
    assert.equal(notice.validTo, Date.parse(raw.properties.validTimeTo));
    assert.ok(isWeatherGeometry(notice.geometry));
    if (notice.issuer !== 'ZAN') assert.deepEqual(notice.geometry, raw.geometry);
    else {
      assert.deepEqual(JSON.parse(notice.sourceGeometry!), raw.geometry);
      assert.equal(notice.geometry.type, 'MultiPolygon');
      if (notice.geometry.type !== 'MultiPolygon') throw new Error('Expected date-line pieces');
      assert.equal(notice.geometry.coordinates.length, 2);
      const outline = notice.outlineGeometry!;
      assert.ok(isWeatherGeometry(outline));
      const lines = outline.type === 'LineString' ? [outline.coordinates] : outline.coordinates;
      assert.ok(lines.flatMap(line => line.slice(1).map((p, i) => [line[i]!, p])).every(([a, b]) =>
        !(Math.abs(a![0]!) === 180 && a![0] === b![0])), 'polygon clipping seams must not become advisory boundaries');
      assert.ok(!isAwcAdvisorySnapshot({ ...snapshot, advisories: [{ ...notice, outlineGeometry: notice.geometry }] }));
      for (const polygon of notice.geometry.coordinates) {
        const longitudes = polygon.flat().map(p => p[0]!);
        assert.ok(Math.max(...longitudes) - Math.min(...longitudes) < 17, 'no world-spanning polygon');
      }
    }
  }
});

test('captured Anchorage 202 completes its declared polygon and outline without changing source evidence', () => {
  const before = structuredClone(openRing.collection);
  const snapshot = normalizeAdvisories('cwa', [openRing.collection], openRing.checkedAt, openRing.source);
  assert.ok(isAwcAdvisorySnapshot(snapshot));
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.issues, undefined);
  assert.equal(snapshot.advisories.length, 1);
  const notice = snapshot.advisories[0]!, raw = before.features[0]!;
  const points = raw.geometry.coordinates[0]!;
  assert.deepEqual(notice.geometry, { type: 'Polygon', coordinates: [[...points, points[0]]] });
  assert.deepEqual(notice.outlineGeometry, { type: 'LineString', coordinates: [...points, points[0]] },
    'the outline must include the same closing edge as the filled polygon');
  assert.deepEqual(JSON.parse(notice.sourceGeometry!), raw.geometry);
  assert.deepEqual(notice.sourceProperties, raw.properties);
  assert.equal(notice.text, raw.properties.cwaText);
  assert.equal(notice.validTo, Date.parse(raw.properties.validTimeTo));
  assert.deepEqual(openRing.collection, before);
  assert.deepEqual(normalizeAdvisoryGeometry(notice.geometry), notice.geometry, 'canonical geometry is idempotent');
  assert.ok(!isWeatherGeometry(raw.geometry), 'wire validation still requires closed rings');
});

test('completed polygon edges, holes and disconnected pieces share fill and seam-free outlines', () => {
  const polygons = [
    [[[190, 0], [190, 20], [170, 20], [170, 0]], [[185, 5], [175, 5], [175, 15], [185, 15]]],
    [[[10, 0], [20, 0], [20, 10]]],
  ];
  const source = { type: 'MultiPolygon', coordinates: polygons };
  const before = structuredClone(source), prepared = prepareAdvisoryGeometry(source);
  const explicit = prepareAdvisoryGeometry({ type: 'MultiPolygon',
    coordinates: polygons.map(rings => rings.map(ring => [...ring, ring[0]!])) });
  assert.deepEqual(prepared, explicit, 'omitted closure cannot change fill or original boundary paths');
  assert.equal(area(prepared.geometry), 350);
  const outline = prepared.outlineGeometry!;
  assert.ok(isWeatherGeometry(outline));
  const lines = outline.type === 'LineString' ? [outline.coordinates] : outline.coordinates;
  const segments = lines.flatMap(line => line.slice(1).map((p, i) => [line[i]!, p]));
  assert.ok(segments.every(([a, b]) => !(Math.abs(a![0]!) === 180 && a![0] === b![0])), 'no clipping seams');
  const length = segments.reduce((sum, [a, b]) => sum + Math.hypot(b![0]! - a![0]!, b![1]! - a![1]!), 0);
  assert.ok(Math.abs(length - (80 + 40 + 20 + Math.sqrt(200))) < 1e-10, 'every closing segment is retained');
  assert.deepEqual(source, before);
  assert.deepEqual(prepareAdvisoryGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 0], [1, 1]] }),
    { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0], [1, 1]] } }, 'lines never gain a closing edge');
});

test('ring completion preserves ambiguity, topology and aggregate coordinate limits', () => {
  for (const ring of [
    [[0, 0], [1, 1]], // Fewer than three distinct corners.
    [[0, 0], [1, 1], [2, 2]], // Zero area.
    [[0, 0], [3, 3], [0, 3], [2, 0]], // Closing a crossing ring cannot repair it.
    [[0, 0], [3, 0], [2, 0], [2, 3], [0, 3]], // Retraced edge.
    [[0, 0], [90, 0], [180, 1]], // Ambiguous closing edge.
    [[0, 0], [100, 0], [200, 10]], // Closing would change longitude world.
    [[0, 0], [1, 91], [2, 0]], // Invalid source coordinate.
  ]) {
    const feature = { ...openRing.collection.features[0], geometry: { type: 'Polygon', coordinates: [ring] } };
    const snapshot = normalizeAdvisories('cwa', [{ type: 'FeatureCollection', features: [feature, ...openRing.collection.features] }],
      openRing.checkedAt, openRing.source);
    assert.equal(snapshot.advisories.length, 1);
    assert.equal(snapshot.issues?.length, 1);
    assert.equal(snapshot.issues[0]!.reason, 'invalid-geometry');
    assert.deepEqual(JSON.parse(snapshot.issues[0]!.sourceFeature), feature);
  }
  const points = [...Array.from({ length: 9996 }, () => [0, 0]), [1, 0], [1, 1], [0, 1]];
  const prepared = prepareAdvisoryGeometry({ type: 'Polygon', coordinates: [points] });
  assert.equal(prepared.geometry.coordinates[0]!.length, 10_000, 'the repeated closure counts toward the limit');
  assert.throws(() => prepareAdvisoryGeometry({ type: 'Polygon', coordinates: [[...points, [0, 0.5]]] }), /closing edge/);
});

test('geographic normalization preserves holes, splits lines, and rejects ambiguous or invalid boundaries', () => {
  const geometry = normalizeAdvisoryGeometry({ type: 'Polygon', coordinates: [
    [[170, 0], [190, 0], [190, 20], [170, 20], [170, 0]],
    [[175, 5], [175, 15], [185, 15], [185, 5], [175, 5]],
  ] });
  assert.equal(geometry.type, 'MultiPolygon');
  if (geometry.type !== 'MultiPolygon') throw new Error('Expected two pieces');
  assert.equal(area(geometry), 300);
  assert.deepEqual(normalizeAdvisoryGeometry({ type: 'LineString', coordinates: [[179, 10], [-179, 12]] }),
    { type: 'MultiLineString', coordinates: [[[179, 10], [180, 11]], [[-180, 11], [-179, 12]]] });
  for (const coordinates of [[[0, 0], [180, 1]], [[NaN, 0], [1, 1]], [[0, 91], [1, 1]], [[720, 0], [721, 1]]]) {
    assert.throws(() => normalizeAdvisoryGeometry({ type: 'LineString', coordinates }));
  }
  assert.deepEqual(normalizeAdvisoryGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }),
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] });
});

test('hole placement is independent of starting vertex, winding and longitude world', () => {
  const exterior = [[-100, -20], [0, -20], [100, -20], [100, 20], [0, 20], [-100, 20]];
  const hole = [[90, -5], [90, 5], [95, 5], [95, -5]];
  for (const explicit of [true, false]) for (const shift of [-360, 0, 180, 360]) for (const reversed of [false, true]) {
    for (let start = 0; start < exterior.length; start++) for (let holeStart = 0; holeStart < hole.length; holeStart++) {
      const rotate = (ring: number[][], offset: number) => {
        const rotated = [...ring.slice(offset), ...ring.slice(0, offset)];
        const points = (reversed ? rotated.reverse() : rotated).map(([lon, lat]) => [lon! + shift, lat!]);
        return explicit ? [...points, points[0]!] : points;
      };
      const geometry = { type: 'Polygon', coordinates: [rotate(exterior, start), rotate(hole, holeStart)] };
      const feature = { ...captured.collection.features[0], geometry };
      const snapshot = normalizeAdvisories('cwa', [{ type: 'FeatureCollection', features: [feature] }], captured.checkedAt, captured.source);
      assert.equal(snapshot.issues, undefined, JSON.stringify(geometry));
      assert.equal(area(snapshot.advisories[0]!.geometry), 7950, 'the 50-square-degree hole must survive every representation');
    }
  }
});

test('uncontained and overlapping holes become source issues instead of silently changing the covered area', () => {
  const exterior = [[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10], [0, 0]];
  const rectangle = (west: number, south: number, east: number, north: number) =>
    [[west, south], [west, north], [east, north], [east, south], [west, south]];
  for (const explicit of [true, false]) for (const holes of [
    [rectangle(20, 1, 22, 2)], // Outside the longitude extent.
    [rectangle(1, 20, 2, 22)], // Outside the latitude extent.
    [rectangle(3, 5, 7, 7)], // Vertices inside; edges cross the exterior's notch.
    [rectangle(1, 1, 3, 3), rectangle(2, 2, 3.5, 3.5)], // Overlapping holes.
    [rectangle(1, 1, 3, 3), rectangle(1.5, 1.5, 2, 2)], // Nested holes.
    [[[1, 1], [1, 1], [1, 1], [1, 1]]], // Empty hole.
    [[[1, 1], [3, 3], [1, 3], [3, 1], [1, 1]]], // Crossing boundary.
    [[[1, 1], [3, 3], [1, 3], [2, 1], [1, 1]]], // Unequal crossing lobes.
    [[[1, 1], [3, 1], [2, 1], [2, 3], [1, 3], [1, 1]]], // Retraced edge.
  ]) {
    const feature = { ...captured.collection.features[0], geometry: { type: 'Polygon',
      coordinates: [exterior, ...holes].map(ring => explicit ? ring : ring.slice(0, -1)) } };
    const snapshot = normalizeAdvisories('cwa', [{ type: 'FeatureCollection', features: [feature, captured.collection.features[1]] }], captured.checkedAt, captured.source);
    assert.equal(snapshot.advisories.length, 1);
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(snapshot.issues?.[0]?.reason, 'invalid-geometry');
    assert.deepEqual(JSON.parse(snapshot.issues![0]!.sourceFeature), feature);
  }
});

test('invalid advisory members remain accounted for while independent entries publish and recover', () => {
  const collection = structuredClone(captured.collection);
  collection.features[6]!.geometry.coordinates[0]![0]![1] = 95;
  const snapshot = normalizeAdvisories('cwa', [collection], captured.checkedAt, captured.source);
  assert.ok(isAwcAdvisorySnapshot(snapshot)); assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.advisories.length, 6); assert.equal(snapshot.issues?.length, 1);
  assert.equal(snapshot.issues![0]!.reason, 'invalid-geometry');
  assert.deepEqual(JSON.parse(snapshot.issues![0]!.sourceFeature), collection.features[6]);
  assert.ok(!isAwcAdvisorySnapshot({ ...snapshot, schemaVersion: 1 }), 'partial data cannot masquerade as the legacy complete contract');
  assert.ok(!isAwcAdvisorySnapshot({ ...snapshot, issues: [] }));
  assert.ok(!isAwcAdvisorySnapshot({ ...snapshot, issues: [...snapshot.issues!, ...snapshot.issues!] }));
  assert.ok(!isAwcAdvisorySnapshot({ ...snapshot, issues: [{ ...snapshot.issues![0], reason: ['invalid-geometry'] }] }));
  const invalid = normalizeAdvisories('cwa', [{ type: 'FeatureCollection', features: [null, { type: 'Feature', properties: {} }] }], captured.checkedAt, captured.source);
  assert.equal(invalid.advisories.length, 0); assert.equal(invalid.issues?.length, 2); assert.equal(invalid.schemaVersion, 2);
  const empty = normalizeAdvisories('cwa', [{ type: 'FeatureCollection', features: [] }], captured.checkedAt, captured.source);
  assert.equal(empty.schemaVersion, 1); assert.equal(empty.issues, undefined);
  assert.equal(normalizeAdvisories('cwa', [captured.collection], captured.checkedAt, captured.source).issues, undefined);
  assert.throws(() => normalizeAdvisories('cwa', [{ ...collection, exceededTransferLimit: true }], captured.checkedAt, captured.source));
  const oversized = structuredClone(captured.collection.features[0]!);
  oversized.properties.cwaText = 'X'.repeat(100_001);
  const bounded = normalizeAdvisories('cwa', [{ type: 'FeatureCollection', features: [oversized, ...captured.collection.features] }], captured.checkedAt, captured.source);
  assert.ok(isAwcAdvisorySnapshot(bounded)); assert.equal(bounded.advisories.length, 7);
  assert.equal(bounded.issues?.length, 1); assert.equal(bounded.issues![0]!.sourceFeatureTruncated, true);
  assert.equal(bounded.issues![0]!.sourceFeature.length, 100_000, 'oversized evidence cannot suppress valid neighbors');
});
