import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import proj4 from 'proj4';

export type Point = [number, number];
export type PlateGeoreference = {
  bounds: [number, number, number, number];
  outline: Point[];
  /** PDF user-space coordinates (origin at bottom left) to WGS84. */
  locate: (point: Point) => Point;
};

const name = PDFName.of;
const geographic = '+proj=longlat +datum=WGS84 +no_defs';

/** Read only an extracted page, never a second in-memory copy of a regional book. */
export async function readPlateGeoreference(bytes: Uint8Array): Promise<PlateGeoreference> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = document.getPage(0);
  const viewports = page.node.lookup(name('VP'));
  if (!(viewports instanceof PDFArray)) throw new Error('This page has no geographic placement data.');
  const candidates: PlateGeoreference[] = [];
  for (let i = 0; i < viewports.size(); i++) {
    const viewport = viewports.lookup(i);
    if (!(viewport instanceof PDFDict)) continue;
    const measure = viewport.lookup(name('Measure'));
    if (!(measure instanceof PDFDict) || measure.lookup(name('Subtype'))?.toString() !== '/GEO') continue;
    candidates.push(readViewport(viewport, measure));
  }
  // Choosing one of several insets can put an approach in the wrong place.
  if (candidates.length !== 1) throw new Error('This page does not have a single supported geographic map area.');
  const result = candidates[0]!;
  const crop = page.getCropBox();
  const [left, bottom, right, top] = result.bounds;
  if (left < crop.x - 1 || bottom < crop.y - 1 || right > crop.x + crop.width + 1 || top > crop.y + crop.height + 1) {
    throw new Error('The geographic area lies outside the PDF page.');
  }
  return result;
}

function numbers(dict: PDFDict, key: string): number[] {
  const array = dict.lookup(name(key));
  if (!(array instanceof PDFArray)) throw new Error(`Missing geographic ${key}.`);
  return Array.from({ length: array.size() }, (_, i) => {
    const value = array.lookup(i);
    if (!(value instanceof PDFNumber) || !Number.isFinite(value.asNumber())) throw new Error(`Invalid geographic ${key}.`);
    return value.asNumber();
  });
}

function pairs(values: number[]): Point[] {
  if (values.length % 2) throw new Error('Invalid geographic point pairs.');
  return Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2]!, values[i * 2 + 1]!]);
}

function readViewport(viewport: PDFDict, measure: PDFDict): PlateGeoreference {
  const box = numbers(viewport, 'BBox');
  if (box.length !== 4 || box[2]! <= box[0]! || box[3]! <= box[1]!) throw new Error('Invalid geographic map area.');
  const bounds = box as PlateGeoreference['bounds'];
  const local = pairs(numbers(measure, 'LPTS'));
  const world = pairs(numbers(measure, 'GPTS'));
  const outline = pairs(numbers(measure, 'Bounds'));
  if (local.length < 3 || local.length > 32 || local.length !== world.length || outline.length < 3 || outline.length > 64 ||
      [...local, ...outline].some(p => p.some(n => n < 0 || n > 1)) ||
      world.some(([lat, lon]) => Math.abs(lat) > 85 || Math.abs(lon) > 180)) throw new Error('Invalid geographic control points.');
  if (Math.abs(outline.reduce((area, p, i) => area + cross(p, outline[(i + 1) % outline.length]!), 0)) < 1e-6) {
    throw new Error('Invalid geographic map boundary.');
  }
  const gcs = measure.lookup(name('GCS'));
  const wkt = gcs instanceof PDFDict ? gcs.lookup(name('WKT')) : undefined;
  if (!(wkt instanceof PDFString || wkt instanceof PDFHexString)) throw new Error('This page has no supported geographic projection.');
  // GPTS pairs are latitude/longitude even when GCS describes a projected CRS.
  const projection = proj4(geographic, wkt.decodeText());
  const projected = world.map(([lat, lon]) => projection.forward([lon, lat]) as Point);
  if (projected.some(p => !p.every(Number.isFinite))) throw new Error('Invalid geographic projection.');
  const transform = fitAffine(local, projected);
  const locate = ([x, y]: Point): Point => {
    const result = projection.inverse(transform([(x - bounds[0]) / (bounds[2] - bounds[0]),
      (y - bounds[1]) / (bounds[3] - bounds[1])])) as Point;
    if (!result.every(Number.isFinite) || Math.abs(result[1]) > 85) throw new Error('Geographic placement is outside the map.');
    return result;
  };
  // Reject inconsistent metadata instead of guessing a fit for a distorted chart.
  for (let i = 0; i < local.length; i++) {
    const [lon, lat] = projection.inverse(transform(local[i]!));
    const [expectedLat, expectedLon] = world[i]!;
    const longitudeError = ((lon! - expectedLon + 540) % 360) - 180;
    if (Math.hypot(longitudeError * Math.cos(expectedLat * Math.PI / 180), lat! - expectedLat) > 0.0001) {
      throw new Error('The geographic control points do not agree.');
    }
  }
  return { bounds, outline: outline.map(([x, y]) => [bounds[0] + x * (bounds[2] - bounds[0]),
    bounds[1] + y * (bounds[3] - bounds[1])]), locate };
}

/** Use a well-spaced triangle, then validate every supplied control point. */
function fitAffine(from: Point[], to: Point[]): (point: Point) => Point {
  let best: [number, number, number] = [0, 0, 0], area = 0;
  for (let a = 0; a < from.length - 2; a++) for (let b = a + 1; b < from.length - 1; b++) for (let c = b + 1; c < from.length; c++) {
    const determinant = cross(subtract(from[b]!, from[a]!), subtract(from[c]!, from[a]!));
    if (Math.abs(determinant) > Math.abs(area)) { best = [a, b, c]; area = determinant; }
  }
  if (Math.abs(area) < 1e-6) throw new Error('The geographic control points are collinear.');
  const [a, b, c] = best;
  const u = subtract(from[b]!, from[a]!), v = subtract(from[c]!, from[a]!);
  return point => {
    const d = subtract(point, from[a]!);
    const s = cross(d, v) / area, t = cross(u, d) / area;
    return [to[a]![0] + s * (to[b]![0] - to[a]![0]) + t * (to[c]![0] - to[a]![0]),
      to[a]![1] + s * (to[b]![1] - to[a]![1]) + t * (to[c]![1] - to[a]![1])];
  };
}

function subtract(a: Point, b: Point): Point { return [a[0] - b[0], a[1] - b[1]]; }
function cross(a: Point, b: Point): number { return a[0] * b[1] - a[1] * b[0]; }
