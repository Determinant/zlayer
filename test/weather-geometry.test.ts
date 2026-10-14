import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { isWeatherGeometry, isSurfaceArtifact, SURFACE_PROCESSING, type WeatherGeometry } from '@zlayer/contracts';
import { wrapLongitude, longitudeNear, dateLineCrossing } from '../src/layers/weather-awc/geographic';
import { prepareAdvisoryGeometry } from '../src/layers/weather-awc/source-geometry';
import { surfaceLineCurve } from '../src/layers/weather-awc/progs/curves';
import { parseSurfaceCatalog, parseSurfaceChart } from '../src/layers/weather-awc/progs/source';
import { surfaceCatalog, surfaceChart } from './fixtures/wpc';
import { WEATHER_NOW } from './fixtures/awc-advisories';
import { randomSequence, signedArea, ringLength, containsPoint, type Point } from './helpers/weather-geometry';

function polygonParts(geometry: WeatherGeometry): Point[][][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates.map(ring => ring.map(position))];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(polygon => polygon.map(ring => ring.map(position)));
  throw new Error('Expected polygon geometry');
}
function polygonArea(geometry: WeatherGeometry): number {
  return polygonParts(geometry).reduce((sum, rings) => sum + Math.abs(signedArea(rings[0]!)) -
    rings.slice(1).reduce((holes, ring) => holes + Math.abs(signedArea(ring)), 0), 0);
}
function filled(geometry: WeatherGeometry, point: Point): boolean {
  return polygonParts(geometry).some(rings => containsPoint(rings[0]!, point) && !rings.slice(1).some(ring => containsPoint(ring, point)));
}
function lineParts(geometry: WeatherGeometry): Point[][] {
  if (geometry.type === 'LineString') return [geometry.coordinates.map(position)];
  if (geometry.type === 'MultiLineString') return geometry.coordinates.map(line => line.map(position));
  return polygonParts(geometry).flat();
}
function position(value: number[]): Point {
  assert.equal(value.length, 2);
  return [value[0]!, value[1]!];
}
function bounded(geometry: WeatherGeometry): void {
  assert.ok(isWeatherGeometry(geometry));
  for (const line of lineParts(geometry)) for (let i = 1; i < line.length; i++) {
    assert.ok(Math.abs(line[i]![0] - line[i - 1]![0]) <= 180, 'no artificial world-spanning edge');
  }
}

test('longitude conventions preserve representable seam neighbors and equivalent world copies', () => {
  const epsilon = 2 ** -45, random = randomSequence(74021);
  const values = [-540, -360, -180 - epsilon, -180, -180 + epsilon, 0, 180 - epsilon, 180, 180 + epsilon, 360, 540,
    ...Array.from({ length: 2000 }, () => (random() - .5) * 10_000)];
  assert.equal(wrapLongitude(180 - epsilon), 180 - epsilon);
  assert.equal(wrapLongitude(-180 + epsilon), -180 + epsilon);
  for (const value of values) {
    const wrapped = wrapLongitude(value);
    assert.ok(wrapped >= -180 && wrapped < 180 && Number.isFinite(wrapped));
    assert.equal(wrapLongitude(wrapped), wrapped);
    assert.ok(Math.abs((value - wrapped) / 360 - Math.round((value - wrapped) / 360)) < 1e-12);
    for (const shift of [-2, -1, 0, 1, 2]) {
      const reference = wrapped + shift * 360;
      assert.ok(Math.abs(longitudeNear(value, reference) - reference) < 1e-12);
    }
  }
  assert.equal(longitudeNear(-180, 0), 180, 'documented eastern tie');
  assert.equal(longitudeNear(180, 0), 180);
});

test('seam intersections conserve length and latitude under direction reversal, including exact endpoints', () => {
  const random = randomSequence(21799), epsilon = 2 ** -45;
  for (let i = 0; i < 1000; i++) {
    const a: Point = [i % 4 === 0 ? -180 : 170 + random() * 10, random() * 180 - 90];
    const b: Point = [i % 4 === 1 ? -180 : -180 + random() * 10, random() * 180 - 90];
    for (const [first, last] of [[a, b], [b, a]] as [Point, Point][]) {
      const crossing = dateLineCrossing(first, last);
      if (!crossing) continue;
      assert.equal(crossing.entering[0], -crossing.leaving[0]);
      assert.equal(crossing.entering[1], crossing.leaving[1]);
      assert.ok(crossing.leaving[1] >= Math.min(a[1], b[1]) && crossing.leaving[1] <= Math.max(a[1], b[1]));
      const length = ringLength([first, crossing.leaving]) + ringLength([crossing.entering, last]);
      const expected = Math.hypot(longitudeNear(last[0], first[0]) - first[0], last[1] - first[1]);
      assert.ok(Math.abs(length - expected) < 1e-10);
      assert.ok(Math.abs(dateLineCrossing(last, first)!.leaving[1] - crossing.leaving[1]) < 1e-12);
    }
  }
  for (const latitude of [-90 + 2 ** -46, 0, 90 - 2 ** -46]) {
    const crossing = dateLineCrossing([180 - epsilon, -latitude], [-180, latitude])!;
    assert.equal(crossing.leaving[1], latitude);
  }
});

test('generated surface paths preserve controls, reversal, world-copy equivalence and canonical chart bounds', () => {
  const random = randomSequence(90371), chart = parseSurfaceCatalog(JSON.stringify(surfaceCatalog()), WEATHER_NOW)[0]!;
  for (let sample = 0; sample < 160; sample++) {
    const controls: Point[] = Array.from({ length: 2 + sample % 19 }, (_, i) => [
      (sample % 2 ? 179 : -179) + Math.round((random() - .5) * 12 * 1e4) / 1e4,
      i % 3 === 0 ? (sample % 3 - 1) * 90 : Math.round((random() * 180 - 90) * 1e4) / 1e4,
    ]);
    if (sample === 0) controls[0]![0] = 180 - 2 ** -45;
    const original = structuredClone(controls), curve = surfaceLineCurve(controls);
    const reverse = surfaceLineCurve([...controls].reverse()).reverse();
    const shifted = surfaceLineCurve(controls.map(([lon, lat]) => [lon + (lon > 0 ? -360 : 360), lat]));
    assert.deepEqual(controls, original);
    assert.equal(curve.length, 16 * (controls.length - 1) + 1);
    controls.forEach(([lon, lat], i) => assert.deepEqual(curve[16 * i], [wrapLongitude(lon), lat]));
    for (const [i, [lon, lat]] of curve.entries()) {
      assert.ok(Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon < 180 && Math.abs(lat) <= 90);
      for (const equivalent of [reverse[i]!, shifted[i]!]) {
        assert.ok(Math.abs(longitudeNear(equivalent[0], lon) - lon) <= 1.00001e-5 && Math.abs(equivalent[1] - lat) <= 1.00001e-5,
          `sample ${sample}, vertex ${i}: equivalent source representation changes the curve`);
      }
    }
    const document = surfaceChart(chart.file);
    document.features.find(f => f.properties.type === 1)!.geometry = { type: 'LineString', coordinates: controls };
    const text = JSON.stringify(document), sourceHash = createHash('sha256').update(text).digest('hex');
    const frame = parseSurfaceChart(text, chart, WEATHER_NOW, sourceHash);
    assert.ok(isSurfaceArtifact({ schemaVersion: 1, processing: SURFACE_PROCESSING, product: 'analysis', frame }));
    for (const feature of frame.features) if (feature.geometry.type !== 'Point') bounded(feature.geometry);
  }
});

test('generated concave advisories preserve coverage, holes and boundary length across representations', () => {
  const random = randomSequence(17293);
  for (let sample = 0; sample < 36; sample++) {
    const count = 7 + sample % 7, radius = sample % 3 === 0 ? .001 : 2;
    const center: Point = [sample % 3 === 0 ? 180 : sample % 3 === 1 ? -179.5 : 0, sample % 2 ? 60 : -60];
    const outer: Point[] = Array.from({ length: count }, (_, i) => {
      const angle = (i + (random() - .5) * .25) * 2 * Math.PI / count, r = (.5 + random() * .5) * radius;
      return [Math.cos(angle) * r, Math.sin(angle) * r];
    });
    const h = radius * (sample % 4 === 0 ? .0001 : .1);
    const hole: Point[] = [[-h, -h], [h, -h], [h, h], [-h, h]];
    const close = (ring: Point[]) => [...ring, ring[0]!];
    const expectedArea = Math.abs(signedArea(close(outer))) - 4 * h * h;
    const expectedLength = ringLength(close(outer)) + 8 * h;
    for (const reverse of [false, true]) for (const world of [-1, 0, 1]) for (const start of [0, 2, count - 1]) {
      const rings = [outer, hole].map((ring, index) => {
        const offset = start % ring.length, rotated = [...ring.slice(offset), ...ring.slice(0, offset)];
        if (reverse !== !!index) rotated.reverse();
        return close(rotated.map(([x, y]): Point => [x + center[0] + world * 360, y + center[1]]));
      });
      if (rings.flat().some(([lon]) => Math.abs(lon) > 540)) continue;
      const source = { type: 'Polygon', coordinates: rings }, original = structuredClone(source);
      const prepared = prepareAdvisoryGeometry(source), label = `sample ${sample}, world ${world}, reverse ${reverse}, start ${start}`;
      bounded(prepared.geometry);
      assert.deepEqual(source, original, label);
      assert.ok(Math.abs(polygonArea(prepared.geometry) - expectedArea) < Math.max(1e-15, expectedArea * 1e-8), label);
      assert.equal(filled(prepared.geometry, [wrapLongitude(center[0]), center[1]]), false, `hole lost: ${label}`);
      assert.equal(filled(prepared.geometry, [wrapLongitude(center[0] + radius * .3), center[1]]), true, `coverage lost: ${label}`);
      const outline = prepared.outlineGeometry ?? prepared.geometry;
      bounded(outline);
      assert.ok(Math.abs(lineParts(outline).reduce((sum, line) => sum + ringLength(line), 0) - expectedLength) < 1e-9, `outline changed: ${label}`);
      const repeated = prepareAdvisoryGeometry(prepared.geometry);
      assert.ok(Math.abs(polygonArea(repeated.geometry) - expectedArea) < Math.max(1e-15, expectedArea * 1e-8), `reprocessing: ${label}`);
    }
  }
});

test('advisory topology cannot hide short reversals inside a numeric perimeter tolerance', () => {
  for (const size of [1, .001]) for (const offset of [1e-8, 1e-12, 1e-13, 1e-14]) {
    const invalid: Point[] = [[0, 0], [2 * size, 0], [2 * size + offset, 0], [2 * size, 0], [2 * size, 2 * size], [0, 2 * size]];
    for (const reverse of [false, true]) for (let start = 0; start < invalid.length; start++) {
      const ring = [...invalid.slice(start), ...invalid.slice(0, start)];
      if (reverse) ring.reverse();
      assert.throws(() => prepareAdvisoryGeometry({ type: 'Polygon', coordinates: [[...ring, ring[0]!]] }), /topology/);
    }
    // Nearby valid geometry and harmless duplicate/forward-collinear points
    // remain supported. Thinness alone is not evidence of invalid topology.
    const ring: Point[] = [[0, 0], [size, 0], [size, 0], [2 * size, 0], [2 * size, offset], [0, offset], [0, 0], [0, 0]];
    const result = prepareAdvisoryGeometry({ type: 'Polygon', coordinates: [ring] });
    assert.ok(Math.abs(polygonArea(result.geometry) - 2 * size * offset) <= 1e-28);
  }
});
