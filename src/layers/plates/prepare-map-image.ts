import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { withAbort } from '../../core/data/abort';
import type { ProcedureSelection } from './data';
import { readPlateGeoreference, type Point } from './georeference';
import { mercator, unmercator, type PlateMapImage } from './map-image';

// At most 16 MiB per canvas, independent of the viewer's zoom or device density.
const MAX_PIXELS = 4_194_304;
const MAX_SIDE = 3072;
const GRID = 24;

export async function preparePlateMapImage(pdf: PDFDocumentProxy, pageIndex: number,
  selection: ProcedureSelection, signal: AbortSignal): Promise<PlateMapImage> {
  signal.throwIfAborted();
  const bytes = await withAbort(pdf.extractPages([{ document: null, includePages: [pageIndex] }]), signal);
  signal.throwIfAborted();
  if (!bytes) throw new Error('Unable to read geographic placement from this PDF page.');
  const geo = await withAbort(readPlateGeoreference(bytes), signal);
  signal.throwIfAborted();
  const page = await withAbort(pdf.getPage(pageIndex + 1), signal);
  const source = document.createElement('canvas');
  const canvas = document.createElement('canvas');
  let render: RenderTask | undefined;
  const cancel = () => render?.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const unscaled = page.getViewport({ scale: 1 });
    const rect = [...unscaled.convertToViewportPoint(geo.bounds[0], geo.bounds[1]),
      ...unscaled.convertToViewportPoint(geo.bounds[2], geo.bounds[3])];
    const left = Math.min(rect[0]!, rect[2]!), top = Math.min(rect[1]!, rect[3]!);
    const width = Math.abs(rect[2]! - rect[0]!), height = Math.abs(rect[3]! - rect[1]!);
    const scale = Math.min(MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
    const viewport = page.getViewport({ scale, offsetX: -left * scale, offsetY: -top * scale });
    source.width = Math.max(1, Math.floor(width * scale));
    source.height = Math.max(1, Math.floor(height * scale));
    const context = source.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable.');
    context.save();
    context.beginPath();
    geo.outline.forEach(([x, y], i) => {
      const point = viewport.convertToViewportPoint(x, y);
      if (i === 0) context.moveTo(point[0]!, point[1]!);
      else context.lineTo(point[0]!, point[1]!);
    });
    context.closePath();
    context.clip();
    signal.throwIfAborted();
    render = page.render({ canvas: source, canvasContext: context, viewport });
    await withAbort(render.promise, signal);
    context.restore();
    signal.throwIfAborted();

    const reference = geo.locate([geo.bounds[0], geo.bounds[1]])[0];
    const unwrap = ([lon, lat]: Point): Point => [lon + Math.round((reference - lon) / 360) * 360, lat];
    const locate = (x: number, y: number) => mercator(unwrap(geo.locate(viewport.convertToPdfPoint(x, y) as Point)));
    const vertices = Array.from({ length: (GRID + 1) ** 2 }, (_, index) => {
      const x = index % (GRID + 1) / GRID * source.width;
      const y = Math.floor(index / (GRID + 1)) / GRID * source.height;
      return { source: [x, y] as Point, target: locate(x, y) };
    });
    const xs = vertices.map(v => v.target[0]), ys = vertices.map(v => v.target[1]);
    const west = Math.min(...xs), east = Math.max(...xs), north = Math.min(...ys), south = Math.max(...ys);
    const dx = east - west, dy = south - north;
    if (!(dx > 0 && dy > 0) || dx > 0.1 || dy > 0.1) throw new Error('The geographic map area is too large.');
    const pixels = Math.min(MAX_SIDE / dx, MAX_SIDE / dy, Math.sqrt(MAX_PIXELS / (dx * dy)));
    canvas.width = Math.max(1, Math.floor(dx * pixels));
    canvas.height = Math.max(1, Math.floor(dy * pixels));
    const output = canvas.getContext('2d');
    if (!output) throw new Error('Canvas rendering is unavailable.');
    for (const vertex of vertices) vertex.target = [(vertex.target[0] - west) / dx * canvas.width,
      (vertex.target[1] - north) / dy * canvas.height];
    // Reproject a fine mesh to Mercator; four-corner stretching loses the FAA
    // Lambert projection's scale and curvature, especially at high latitudes.
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const a = vertices[y * (GRID + 1) + x]!, b = vertices[y * (GRID + 1) + x + 1]!;
      const c = vertices[(y + 1) * (GRID + 1) + x]!, d = vertices[(y + 1) * (GRID + 1) + x + 1]!;
      triangle(output, source, [a, b, c]);
      triangle(output, source, [b, d, c]);
    }
    signal.throwIfAborted();
    return { selection, canvas, coordinates: [unmercator([west, north]), unmercator([east, north]),
      unmercator([east, south]), unmercator([west, south])],
      outline: geo.outline.map(p => unwrap(geo.locate(p))) };
  } catch (error) {
    canvas.width = canvas.height = 0;
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    source.width = source.height = 0;
    // PDF.js defers cleanup while another consumer is rendering this page.
    page.cleanup();
  }
}

function triangle(context: CanvasRenderingContext2D, image: HTMLCanvasElement,
  [a, b, c]: { source: Point; target: Point }[]) {
  const [sx, sy] = a!.source;
  const ux = b!.source[0] - sx, uy = b!.source[1] - sy, vx = c!.source[0] - sx, vy = c!.source[1] - sy;
  const determinant = ux * vy - uy * vx;
  const [tx, ty] = a!.target;
  const dux = b!.target[0] - tx, duy = b!.target[1] - ty, dvx = c!.target[0] - tx, dvy = c!.target[1] - ty;
  const m0 = (dux * vy - dvx * uy) / determinant, m1 = (duy * vy - dvy * uy) / determinant;
  const m2 = (dvx * ux - dux * vx) / determinant, m3 = (dvy * ux - duy * vx) / determinant;
  context.save();
  context.beginPath();
  // Canvas antialiases clip edges independently. A small overlap prevents
  // transparent grid seams without changing the geographic transform.
  const center: Point = [(tx + b!.target[0] + c!.target[0]) / 3, (ty + b!.target[1] + c!.target[1]) / 3];
  for (const [i, vertex] of [a!, b!, c!].entries()) {
    const dx = vertex.target[0] - center[0], dy = vertex.target[1] - center[1];
    const expand = 2 / Math.hypot(dx, dy);
    const point: Point = [vertex.target[0] + dx * expand, vertex.target[1] + dy * expand];
    if (i === 0) context.moveTo(...point);
    else context.lineTo(...point);
  }
  context.closePath();
  context.clip();
  context.setTransform(m0, m1, m2, m3, tx - m0 * sx - m2 * sy, ty - m1 * sx - m3 * sy);
  context.drawImage(image, 0, 0);
  context.restore();
}
