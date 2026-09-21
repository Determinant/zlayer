import assert from 'node:assert/strict';
import test from 'node:test';
import { segmentsForTile, type Point, type Segment } from '../src/layers/terrain/geometry';
import { terrainIsolines } from '../src/layers/terrain/isolines';
import { terrainBorder, stitchTerrainContours } from '../src/layers/terrain/seams';

function fixture(width: number, height: number, center: Point, size = 32, x = 1320, dropEdge = false) {
  const z = 13, y = 3190, scale = 2 ** z;
  const segments: Segment[] = [[[x / scale, y / scale], [(x + width) / scale, (y + height) / scale]]];
  const parts = Array.from({ length: width * height }, (_, i) => {
    const column = i % width, row = Math.floor(i / width);
    const tile = { z, x: (x + column) % scale, y: y + row };
    const values = Float32Array.from({ length: size * size }, (_, j) => {
      if (dropEdge && column === 1 && j % size === 0) return NaN;
      return 2000 - Math.hypot(column + (j % size + 0.5) / size - center[0],
        row + (Math.floor(j / size) + 0.5) / size - center[1]) * 2200;
    });
    return { lines: terrainIsolines(values, size, tile, segmentsForTile(tile, segments), 1000, 256, false).lines,
      border: terrainBorder(values, size, tile, 1000, 256) };
  });
  return { parts, segments, stitch: () => stitchTerrainContours(parts.flatMap(part => part.lines), parts.map(part => part.border), segments) };
}

function assertClosedPeak(lines: ReturnType<typeof stitchTerrainContours>) {
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.elevation, 1000);
  assert.equal(lines[0]!.opacity, 1);
  assert.equal(lines[0]!.coordinates.length, 1, 'a peak spanning tiles should form one joined loop');
  const path = lines[0]!.coordinates[0]!;
  assert.ok(path.length > 4);
  assert.deepEqual(path[0], path.at(-1));
  return path;
}

test('contours spanning vertical and horizontal DEM seams close from the shared samples', () => {
  for (const [width, height, center] of [[2, 1, [0.985, 0.5]], [1, 2, [0.5, 0.985]]] as const) {
    const f = fixture(width, height, [...center]);
    const original = structuredClone(f.parts);
    assertClosedPeak(f.stitch());
    assert.deepEqual(f.parts, original, 'joining must not mutate cached lines or border samples');
    assertClosedPeak(f.stitch());
  }
});

test('four-tile corners close even when a contour crosses the corner cell', () => {
  assertClosedPeak(fixture(2, 2, [0.985, 0.985]).stitch());
  // A coarse grid makes the corner cell large enough for the boundary to pass
  // through it, rather than merely enclosing the tile junction.
  assertClosedPeak(fixture(2, 2, [0.68, 0.68], 8).stitch());
});

test('missing neighbors and missing elevation samples leave real gaps open', () => {
  const f = fixture(2, 1, [0.985, 0.5]), first = f.parts[0]!;
  const missing = stitchTerrainContours(first.lines, [first.border], f.segments);
  assert.ok(missing.some(line => line.coordinates.some(path => JSON.stringify(path[0]) !== JSON.stringify(path.at(-1)))));
  const unknown = fixture(2, 1, [0.985, 0.5], 32, 1320, true).stitch();
  assert.ok(unknown.some(line => line.coordinates.some(path => JSON.stringify(path[0]) !== JSON.stringify(path.at(-1)))));
});

test('a peak crossing the antimeridian closes without a world-spanning segment', () => {
  const path = assertClosedPeak(fixture(2, 1, [0.985, 0.5], 32, 8191).stitch());
  for (let i = 1; i < path.length; i++) assert.ok(Math.abs(path[i]![0] - path[i - 1]![0]) < 1);
});
