// Opt-in benchmark entry; never imported by the application.
import { setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import { Map } from '../../src/core/map/map';
import mapWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { isRadarContours, isSurfaceArtifact, type RadarContours, type SurfaceArtifact } from '@zlayer/contracts';
import { preparedJson } from '../../src/layers/weather-awc/prepared-file';
import { radarFeatures } from '../../src/layers/weather-awc/radar/geometry';
import { terrainBorder, stitchTerrainContours, terrainSeamLines, joinTerrainContours, prepareTerrainContours } from '../../src/layers/terrain/seams';
import { terrainIsolines } from '../../src/layers/terrain/isolines';
import { segmentsForTile, type Segment } from '../../src/layers/terrain/geometry';
import { preparePlateMapImage } from '../../src/layers/plates/prepare-map-image';
import type { ProcedureSelection } from '../../src/layers/plates/data';
import { createLandingHeatLayer } from '../../src/layers/glide/landing-heat-layer';
import { landingHeatPyramid, type LandingHeatTile } from '../../src/layers/glide/landing-heat-tiles';
import { project } from '../../src/core/geo/route-corridor';
import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(mapWorker); GlobalWorkerOptions.workerSrc = pdfWorker;
const map = new Map({ container: 'map', center: [-100, 37], zoom: 3, attributionControl: false,
  style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#fff' } }] } });
const loaded = new Promise<void>((resolve, reject) => { map.once('load', () => resolve()); map.once('error', e => reject(e.error)); });
const experiment = new Worker(new URL('./render-preparation.worker.ts', import.meta.url), { type: 'module' });
function workerExperiment(data: unknown) {
  return new Promise<{ value: unknown; workMs: number; sendMs: number }>((resolve, reject) => {
    experiment.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve({ ...data, sendMs });
    experiment.onerror = reject;
    const start = performance.now();
    // Cache publication still owns the input; transferring it would detach it.
    experiment.postMessage(data);
    const sendMs = performance.now() - start;
  });
}
async function measure<T>(work: () => T | Promise<T>) {
  const gaps: number[] = []; let previous = performance.now();
  const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 1);
  const start = performance.now();
  try { const value = await work(), elapsedMs = performance.now() - start; await new Promise(resolve => setTimeout(resolve, 8));
    return { value, elapsedMs, maxTaskGapMs: Math.max(0, ...gaps) }; }
  finally { clearInterval(timer); }
}
async function fixture(name: string) {
  const response = await fetch(`/${name}.json`);
  return { bytes: await response.arrayBuffer(), sha256: response.headers.get('x-fixture-sha256')! };
}
const inputs = Promise.all([fixture('radar'), fixture('progs')]);
function terrainFixture() {
  const width = 6, size = 128, z = 11, x = 328, y = 796, scale = 2 ** z;
  const segments: Segment[] = [[[x / scale, y / scale], [(x + width) / scale, (y + width) / scale]]];
  const parts = Array.from({ length: width ** 2 }, (_, i) => {
    const tile = { z, x: x + i % width, y: y + Math.floor(i / width) };
    const values = Float32Array.from({ length: size ** 2 }, (_, j) => 5000 + 3000 * Math.sin((tile.x + (j % size + .5) / size) * 20)
      * Math.cos((tile.y + (Math.floor(j / size) + .5) / size) * 20));
    return { lines: terrainIsolines(values, size, tile, segmentsForTile(tile, segments), 500, 512, false).lines,
      border: terrainBorder(values, size, tile, 500, 512) };
  });
  return { parts, segments };
}
async function plateFixture() {
  const document = await PDFDocument.create(), page = document.addPage([200, 200]);
  page.drawRectangle({ width: 200, height: 200, color: rgb(0, 0, 1) });
  page.drawRectangle({ x: 0, y: 150, width: 50, height: 50, color: rgb(1, 0, 0) });
  page.node.set(PDFName.of('VP'), document.context.obj([{ BBox: [0, 0, 200, 200], Measure: {
    Type: 'Measure', Subtype: 'GEO', Bounds: [0, 0, 1, 0, 1, 1, 0, 1], LPTS: [0, 0, 1, 0, 1, 1, 0, 1],
    GPTS: [35, -122, 35, -121, 36, -121, 36, -122], GCS: { Type: 'GEOGCS', WKT: PDFString.of('GEOGCS["WGS 84",DATUM["WGS_1984",' +
      'SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]') },
  } }]));
  return getDocument({ data: await document.save(), useSystemFonts: true });
}
const terrain = terrainFixture(), pdfTask = plateFixture();
const selection: ProcedureSelection = { airport: { id: 'TEST' }, procedure: { id: 'test', name: 'Benchmark' },
  document: { url: 'https://test/plate.pdf', nativeUrl: 'https://test/plate.pdf', pageIndex: 0, source: 'faa-individual' },
  cycle: '2609', effectiveDate: '2026-09-03', expirationDate: '2026-10-01' };
function heatTiles(): LandingHeatTile[] {
  const [cx, cy] = project([-100, 37]), step = 1 / 512;
  return Array.from({ length: 64 }, (_, i) => {
    const w = cx + (i % 8 - 4) * step, n = cy + (Math.floor(i / 8) - 4) * step;
    const levels = landingHeatPyramid({ width: 256, height: 256, coverage: new Float32Array(256 ** 2).fill(255),
      preference: new Float32Array(256 ** 2).fill(255) });
    return { key: String(i), extent: [w, n, w + step, n + step], levels,
      vertices: new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]) };
  });
}
async function weather(name: 'radar' | 'progs', input: { bytes: ArrayBuffer; sha256: string }) {
  const decoded = await measure(() => preparedJson(input.bytes, input.sha256));
  const validated = await measure(() => name === 'radar' ? isRadarContours(decoded.value) : isSurfaceArtifact(decoded.value));
  if (!validated.value) throw new Error(`Invalid ${name} benchmark fixture`);
  const copied = await measure(() => workerExperiment({ name, ...input }));
  if (JSON.stringify(copied.value.value) !== JSON.stringify(decoded.value)) throw new Error('Worker result changed');
  const geometry = await measure(() => name === 'radar' ? radarFeatures([decoded.value as RadarContours])
    : (decoded.value as SurfaceArtifact).frame.features.map(f => ({ type: 'Feature' as const, geometry: f.geometry, properties: { kind: f.kind } })));
  map.addSource('bench-weather', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, buffer: 8 });
  map.addLayer({ id: 'bench-weather', source: 'bench-weather', type: 'line', paint: { 'line-color': '#f00' } });
  try {
    const submission = await measure(() => (map.getSource('bench-weather') as GeoJSONSource).setData({ type: 'FeatureCollection', features: geometry.value }));
    return { bytes: input.bytes.byteLength, decodeMs: decoded.elapsedMs, validationMs: validated.elapsedMs, geometryMs: geometry.elapsedMs,
      sourceAcceptanceMs: submission.elapsedMs, maxTaskGapMs: Math.max(decoded.maxTaskGapMs, validated.maxTaskGapMs, geometry.maxTaskGapMs, submission.maxTaskGapMs),
      worker: { elapsedMs: copied.elapsedMs, maxTaskGapMs: copied.maxTaskGapMs, workMs: copied.value.workMs, sendMs: copied.value.sendMs },
      features: geometry.value.length };
  } finally {
    map.removeLayer('bench-weather'); map.removeSource('bench-weather');
    const idle = map.once('idle'); map.triggerRepaint(); await idle;
  }
}
async function run() {
  await loaded; const [radar, progs] = await inputs;
  const radarResult = await weather('radar', radar!), progsResult = await weather('progs', progs!);
  const stitched = await measure(() => stitchTerrainContours(terrain.parts.flatMap(p => p.lines), terrain.parts.map(p => p.border), terrain.segments));
  const seamCells = await measure(() => terrainSeamLines(terrain.parts.map(p => p.border), terrain.segments));
  const joined = await measure(() => joinTerrainContours([...terrain.parts.flatMap(p => p.lines), ...seamCells.value]));
  const copied = await measure(() => workerExperiment({ name: 'terrain', lines: terrain.parts.flatMap(p => p.lines),
    borders: terrain.parts.map(p => p.border), segments: terrain.segments }));
  if (JSON.stringify(copied.value.value) !== JSON.stringify(stitched.value)) throw new Error('Worker terrain changed');
  const cooperative = await measure(() => prepareTerrainContours(terrain.parts.flatMap(p => p.lines),
    terrain.parts.map(p => p.border), terrain.segments, new AbortController().signal));
  if (JSON.stringify(cooperative.value) !== JSON.stringify(stitched.value)) throw new Error('Cooperative terrain changed');
  const pdf = await (await pdfTask).promise;
  const meshTasks: { draws: number; ms: number }[] = [];
  let task: { draws: number; ms: number } | undefined, started = 0;
  const drawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = new Proxy(drawImage, { apply(target, receiver, args) {
    if (!task) {
      task = { draws: 0, ms: 0 }; meshTasks.push(task); started = performance.now();
      setTimeout(() => { task = undefined; }, 0);
    }
    const result = Reflect.apply(target, receiver, args);
    task.draws++; task.ms = performance.now() - started;
    return result;
  } });
  const plate = await measure(() => preparePlateMapImage(pdf, 0, selection, new AbortController().signal))
    .finally(() => { CanvasRenderingContext2D.prototype.drawImage = drawImage; });
  if (meshTasks.reduce((n, t) => n + t.draws, 0) !== 1152) throw new Error('Incomplete plate mesh');
  const canvas = plate.value.canvas, pixel = [...canvas.getContext('2d')!.getImageData(Math.floor(canvas.width * .1), Math.floor(canvas.height * .1), 1, 1).data];
  if (pixel.join(',') !== '255,0,0,255') throw new Error('Plate placement pixels changed');
  canvas.width = canvas.height = 0;
  const tiles = heatTiles(), heat = createLandingHeatLayer('bench-heat');
  const frames: { ms: number; mips: number }[] = [];
  const original = heat.layer.render.bind(heat.layer);
  heat.layer.render = (gl, options) => {
    let mips = 0; const upload = gl.texImage2D;
    gl.texImage2D = new Proxy(upload, { apply(target, receiver, args) { mips++; return Reflect.apply(target, receiver, args); } });
    const start = performance.now();
    try { original(gl, options); } finally { gl.texImage2D = upload; frames.push({ ms: performance.now() - start, mips }); }
  };
  map.addLayer(heat.layer);
  try {
    const pending = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { map.off('render', check); reject(new Error('Heat uploads did not complete')); }, 30_000);
      const check = () => { if (frames.reduce((sum, f) => sum + f.mips, 0) === 64 * 9) { clearTimeout(timeout); map.off('render', check); resolve(); } };
      map.on('render', check);
    });
    const heatResult = await measure(async () => { heat.set(tiles); await pending; });
    return { radar: radarResult, progs: progsResult,
      terrain: { elapsedMs: stitched.elapsedMs, maxTaskGapMs: stitched.maxTaskGapMs, seamCellsMs: seamCells.elapsedMs, joinMs: joined.elapsedMs,
        worker: { elapsedMs: copied.elapsedMs, maxTaskGapMs: copied.maxTaskGapMs, workMs: copied.value.workMs, sendMs: copied.value.sendMs },
        cooperative: { elapsedMs: cooperative.elapsedMs, maxTaskGapMs: cooperative.maxTaskGapMs },
        paths: stitched.value.reduce((n, l) => n + l.coordinates.length, 0) },
      plate: { elapsedMs: plate.elapsedMs, maxTaskGapMs: plate.maxTaskGapMs, meshTasks, pixel },
      glide: { elapsedMs: heatResult.elapsedMs, maxTaskGapMs: heatResult.maxTaskGapMs, frames } };
  } finally { map.removeLayer('bench-heat'); }
}
Object.assign(window, { preparationBenchmark: { run } });
