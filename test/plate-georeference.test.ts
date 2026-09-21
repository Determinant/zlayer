import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { readPlateGeoreference } from '../src/layers/plates/georeference';
import { plateContains } from '../src/layers/plates/map-image';

const wkt = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
async function plate(options: { absent?: boolean; local?: number[]; world?: number[]; multiple?: boolean; rotation?: number; projection?: string } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 600]);
  if (options.rotation) page.node.set(PDFName.of('Rotate'), pdf.context.obj(options.rotation));
  if (!options.absent) {
    const viewport = pdf.context.obj({ BBox: [20, 100, 380, 500], Measure: {
      Type: 'Measure', Subtype: 'GEO', Bounds: [0, 0, 1, 0, 1, 1, 0, 1],
      LPTS: options.local ?? [0, 0, 1, 0, 1, 1, 0, 1],
      GPTS: options.world ?? [35, -122, 35, -121, 36, -121, 36, -122],
      GCS: { Type: 'GEOGCS', WKT: PDFString.of(options.projection ?? wkt) },
    } });
    // Indirect dictionaries and compressed objects are normal PDF features.
    const ref = pdf.context.register(viewport);
    page.node.set(PDFName.of('VP'), pdf.context.obj(options.multiple ? [ref, ref] : [ref]));
  }
  return pdf.save();
}

test('reads compressed/indirect geospatial metadata with PDF coordinates, axis order and rotation intact', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const geo = await readPlateGeoreference(await plate({ rotation }));
    const position = geo.locate([200, 300]);
    assert.ok(Math.abs(position[0] + 121.5) < 1e-9);
    assert.ok(Math.abs(position[1] - 35.5) < 1e-9);
    assert.deepEqual(geo.bounds, [20, 100, 380, 500]);
    assert.deepEqual(geo.outline[0], [20, 100]);
  }
});

test('FAA Lambert/NAD83 control points in inches retain their published geographic positions', async () => {
  // HWD RNAV (GPS) RWY 28L, FAA SW2 page 220, cycle 2609. These are metadata,
  // not a hand-positioned airport anchor or a guess from the printed page scale.
  const world = [37.08297318321, -122.2895139025, 37.08297907856, -121.701036435,
    37.83532542989, -121.697976457, 37.83531947156, -122.2925976055];
  const local = [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9];
  const projection = 'PROJCS["FAA LCC",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",' +
    'SPHEROID["GRS_1980",6378137,298.25722210]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]],' +
    'PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",0],PARAMETER["False_Northing",0],' +
    'PARAMETER["Central_Meridian",-121.994138888889],PARAMETER["Latitude_Of_Origin",37.5623888888889],' +
    'PARAMETER["Standard_Parallel_1",45],PARAMETER["Standard_Parallel_2",33],UNIT["Inch",0.02540005080010]]';
  const geo = await readPlateGeoreference(await plate({ projection, local, world }));
  for (let i = 0; i < 4; i++) {
    const [lon, lat] = geo.locate([20 + 360 * local[2 * i]!, 100 + 400 * local[2 * i + 1]!]);
    assert.ok(Math.abs(lon - world[2 * i + 1]!) < 1e-8);
    assert.ok(Math.abs(lat - world[2 * i]!) < 1e-8);
  }
});

test('rejects absent, ambiguous, collinear and inconsistent geographic metadata', async () => {
  await assert.rejects(readPlateGeoreference(await plate({ absent: true })), /no geographic/);
  await assert.rejects(readPlateGeoreference(await plate({ multiple: true })), /single supported/);
  await assert.rejects(readPlateGeoreference(await plate({ local: [0, 0, 0.2, 0.2, 0.4, 0.4, 0.6, 0.6] })), /collinear/);
  await assert.rejects(readPlateGeoreference(await plate({ world: [35, -122, 35, -121, 36, -121, 37, -122] })), /do not agree/);
});

test('hit testing excludes transparent corners and recognizes antimeridian world copies', () => {
  const image = { outline: [[179, 1], [180, 2], [181, 1], [180, 0]] as [number, number][] };
  assert.equal(plateContains(image, [-180, 1]), true);
  assert.equal(plateContains(image, [540, 1]), true);
  assert.equal(plateContains(image, [179.05, 1.95]), false);
  assert.equal(plateContains(image, [177, 1]), false);
});
