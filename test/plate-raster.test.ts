import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, PDFName, PDFString, degrees, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { preparePlateMapImage } from '../src/layers/plates/prepare-map-image';
import type { ProcedureSelection } from '../src/layers/plates/data';

test('reprojected plates stay upright, bounded and opaque across mesh seams, including rotated PDFs', async t => {
  const original = globalThis.document;
  globalThis.document = { createElement: () => createCanvas(1, 1) } as unknown as Document;
  t.after(() => { globalThis.document = original; });
  const selection: ProcedureSelection = { airport: { id: 'TEST' }, procedure: { id: 'test', name: 'Test approach' },
    document: { url: 'https://test/plate.pdf', nativeUrl: 'https://test/plate.pdf', pageIndex: 0, source: 'faa-individual' },
    cycle: '2609', effectiveDate: '2026-09-03', expirationDate: '2026-10-01' };
  for (const rotation of [0, 90]) {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 200]);
    page.setRotation(degrees(rotation));
    page.drawRectangle({ width: 200, height: 200, color: rgb(0, 0, 1) });
    page.drawRectangle({ x: 0, y: 150, width: 50, height: 50, color: rgb(1, 0, 0) });
    page.drawRectangle({ x: 150, y: 150, width: 50, height: 50, color: rgb(0, 1, 0) });
    page.node.set(PDFName.of('VP'), document.context.obj([{ BBox: [0, 0, 200, 200], Measure: {
      Type: 'Measure', Subtype: 'GEO', Bounds: [0, 0, 1, 0, 1, 1, 0, 1],
      LPTS: [0, 0, 1, 0, 1, 1, 0, 1], GPTS: [35, -122, 35, -121, 36, -121, 36, -122],
      GCS: { Type: 'GEOGCS', WKT: PDFString.of('GEOGCS["WGS 84",DATUM["WGS_1984",' +
        'SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]') },
    } }]));
    const task = getDocument({ data: await document.save(), useSystemFonts: true });
    try {
      const image = await preparePlateMapImage(await task.promise, 0, selection, new AbortController().signal);
      const { width, height } = image.canvas;
      assert.ok(width * height <= 4_194_304);
      assert.ok(width <= 3072 && height <= 3072);
      const context = image.canvas.getContext('2d')!;
      const pixel = (x: number, y: number) => [...context.getImageData(Math.floor(x * width), Math.floor(y * height), 1, 1).data];
      assert.deepEqual(pixel(0.1, 0.1), [255, 0, 0, 255]);
      assert.deepEqual(pixel(0.9, 0.1), [0, 255, 0, 255]);
      const pixels = context.getImageData(Math.floor(width * 0.4), Math.floor(height * 0.4),
        Math.floor(width * 0.2), Math.floor(height * 0.2)).data;
      for (let i = 3; i < pixels.length; i += 4) assert.equal(pixels[i], 255, 'no transparent seams through opaque chart content');
      image.canvas.width = image.canvas.height = 0;
    } finally { await task.destroy(); }
  }
});
