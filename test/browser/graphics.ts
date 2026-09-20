// Production renderers with deterministic, asymmetric fixtures and pixel probes.
// This entry is included only in the browser-test build.
import { Map, setWorkerUrl, addProtocol, removeProtocol, type GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { CatalogResponse, FeatureCollectionResponse } from '@zlayer/contracts';
import { createRouteResolver } from '@zlayer/domain';
import { createMbtilesReader } from '../../src/layers/charts/mbtiles-reader';
import { renderRegionalTile } from '../../src/layers/charts/regional-tiles';
import { installNavigationLayers } from '../../src/layers/navigation/renderer';
import { createNavigationIcon, NAVIGATION_ICON_IDS } from '../../src/layers/navigation/symbols';
import { installMetarLayers } from '../../src/layers/metar-taf/metar/renderer';
import { installRouteLayers, syncRoute } from '../../src/layers/routes/renderer';
import { ROUTE_LINE_ANCHOR } from '../../src/core/map/layer';
import { bitmapTransfers } from './bitmap-transfer';
import 'maplibre-gl/dist/maplibre-gl.css';

type Pixel = number[];
const COLORS = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 128, 0, 128]];
const SAMPLE_POINTS = [[32, 32], [224, 32], [32, 224], [224, 224], [128, 128]];

async function png(quadrants: number[][]): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(256, 256), context = canvas.getContext('2d')!;
  try {
    const image = context.createImageData(256, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      image.data.set(quadrants[Number(x >= 128) + 2 * Number(y >= 128)]!, (y * 256 + x) * 4);
    }
    context.putImageData(image, 0, 0);
    return await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  } finally { canvas.width = canvas.height = 0; }
}

async function pixels(data: ArrayBuffer | ImageBitmap | null): Promise<Pixel[]> {
  if (!data) return SAMPLE_POINTS.map(() => [0, 0, 0, 0]);
  const bitmap = data instanceof ArrayBuffer ? await createImageBitmap(new Blob([data])) : data;
  const canvas = new OffscreenCanvas(256, 256), context = canvas.getContext('2d')!;
  try {
    context.drawImage(bitmap, 0, 0);
    return SAMPLE_POINTS.map(([x, y]) => [...context.getImageData(x!, y!, 1, 1).data]);
  } finally { bitmap.close(); canvas.width = canvas.height = 0; }
}

async function chartPixels() {
  const signal = new AbortController().signal;
  const encoded = await png(COLORS);
  const parent = await createMbtilesReader(async (_sql, parameters) => parameters.length
    ? [{ data: encoded }] : [{ minZoom: 0, maxZoom: 0 }]);
  const native = await pixels(await parent({ z: 0, x: 0, y: 0 }, signal));
  const children: Pixel[][] = [];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    children.push(await pixels(await parent({ z: 1, x, y }, signal)));
  }
  const tiles = await Promise.all(COLORS.slice(0, 3).map(color => png([color, color, color, color])));
  const overview = await createMbtilesReader(async (_sql, parameters) => parameters.length
    ? tiles.map((data, i) => ({ data, x: i % 2, y: 1 - Math.floor(i / 2) }))
    : [{ minZoom: 1, maxZoom: 1 }]);
  const sparse = await pixels(await overview({ z: 0, x: 0, y: 0 }, signal));
  const catalog: CatalogResponse = { schemaVersion: 1, revision: 'test', generatedAt: '', charts: [], navigation: [], weather: [] };
  const second = { ...catalog };
  const square: [number, number][] = [[0, 0], [256, 0], [256, 256], [0, 256], [0, 0]];
  const hole: [number, number][] = [[96, 96], [160, 96], [160, 160], [96, 160], [96, 96]];
  const clipped = await pixels(await renderRegionalTile([
    { catalog, geometry: [[square, hole]] }, { catalog: second, geometry: [[hole]] },
  ], async source => source === catalog ? encoded : null, signal));
  return { native, children, sparse, clipped };
}

async function rasterPixels(composed: boolean) {
  const encoded = await png(COLORS);
  const children = await Promise.all(COLORS.map(color => png([color, color, color, color])));
  const read = await createMbtilesReader(async (_sql, parameters) => parameters.length
    ? children.map((data, i) => ({ data, x: i % 2, y: 1 - Math.floor(i / 2) }))
    : [{ minZoom: 1, maxZoom: 1 }]);
  const protocol = 'graphics-raster';
  addProtocol(protocol, async (_request, controller) => ({
    data: composed ? await read({ z: 0, x: 0, y: 0 }, controller.signal) : encoded.slice(0),
  }));
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;inset:0;width:512px;height:512px';
  document.body.append(container);
  let raster: Map | undefined;
  try {
    raster = new Map({ container, center: [0, 0], zoom: 0, renderWorldCopies: false, attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      style: { version: 8, sources: { tile: { type: 'raster', tileSize: 512, maxzoom: 0, tiles: [`${protocol}://tile`] } },
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } },
          { id: 'chart', type: 'raster', source: 'tile', paint: { 'raster-fade-duration': 0 } }] } });
    await new Promise<void>((resolve, reject) => {
      raster!.once('idle', () => resolve());
      raster!.once('error', event => reject(event.error));
    });
    const canvas = raster.getCanvas(), gl = canvas.getContext('webgl2')!;
    const ratio = canvas.width / 512;
    return SAMPLE_POINTS.slice(0, 4).map(([x, y]) => {
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(x! * 2 * ratio), canvas.height - Math.floor(y! * 2 * ratio) - 1,
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return [...pixel];
    });
  } finally { raster?.remove(); container.remove(); removeProtocol(protocol); }
}

function iconPixels() {
  return NAVIGATION_ICON_IDS.map(id => {
    const { width, height, data } = createNavigationIcon(id);
    let opaque = 0, minX = width, minY = height, maxX = 0, maxY = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 128) {
        opaque++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
    return { id, width, height, opaque, bounds: [minX, minY, maxX, maxY], center: [...data.slice(center, center + 4)] };
  });
}

setWorkerUrl(workerUrl);
const map = new Map({ container: 'map', center: [-122, 37], zoom: 11, fadeDuration: 0,
  attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true },
  style: { version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {}, layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#eeeae1' } },
    { id: ROUTE_LINE_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } },
  ] } });
const probes: { name: string; coordinate: [number, number] }[] = [];
const errors: string[] = [];
map.on('error', event => errors.push(event.error.message));
map.on('movestart', () => { document.body.dataset.idle = 'false'; });
map.on('idle', () => { document.body.dataset.idle = 'true'; });
map.on('webglcontextlost', () => { document.body.dataset.context = 'lost'; document.body.dataset.idle = 'false'; });
map.on('webglcontextrestored', () => { document.body.dataset.context = 'restored'; });
const collection = (features: FeatureCollectionResponse['features']): FeatureCollectionResponse => ({
  type: 'FeatureCollection', features, meta: { layer: 'airports', revision: 'test', returned: features.length, truncated: false },
});
map.on('load', () => {
  installNavigationLayers(map);
  const feature = (name: string, x: number, y: number, properties = {}) => {
    const coordinate = map.unproject([x, y]).toArray();
    probes.push({ name, coordinate });
    return { type: 'Feature' as const, id: name, geometry: { type: 'Point' as const, coordinates: coordinate },
      properties: { ident: name, ...properties } };
  };
  const fix = feature('FIX', 350, 260, { mapFixMinZoom: 0, mapFixPriority: 0 });
  const vor = feature('VOR', 640, 260, { type: 'VOR' });
  const vfr = feature('VFR', 930, 260);
  for (const [source, point] of [['nav-fixes', fix], ['nav-navaids', vor], ['nav-vfr-waypoints', vfr]] as const) {
    (map.getSource(source) as GeoJSONSource).setData(collection([point]));
  }
  const airports = collection(['VFR', 'MVFR', 'IFR', 'LIFR'].map((category, i) =>
    feature(`WX-${category}`, 400 + i * 160, 640, { displayFlightCategory: category, icaoId: `WX${i}` })));
  installMetarLayers(map, airports);
  const route = collection([feature('AAAA', 350, 440), feature('BBBB', 930, 440)]);
  installRouteLayers(map);
  syncRoute(map, createRouteResolver([route])('AAAA BBBB'));
  probes.push({ name: 'route', coordinate: map.unproject([640, 440]).toArray() });
  document.body.dataset.ready = 'true';
});

function mapPixels() {
  const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')!;
  const ratio = canvas.width / canvas.clientWidth;
  return probes.map(({ name, coordinate }) => {
    const point = map.project(coordinate), data = new Uint8Array(4);
    gl.readPixels(Math.floor(point.x * ratio), canvas.height - Math.floor(point.y * ratio) - 1,
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { name, color: [...data], x: point.x, y: point.y };
  });
}

window.graphicsFixture = { bitmapTransfers, chartPixels, rasterPixels, iconPixels, mapPixels, errors,
  camera: (bearing: number) => map.jumpTo({ bearing }),
  restoreContext: () => {
    const extension = map.getCanvas().getContext('webgl2')!.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('WEBGL_lose_context is unavailable');
    extension.loseContext();
    setTimeout(() => extension.restoreContext(), 100);
  },
};
declare global { interface Window { graphicsFixture: {
  bitmapTransfers: typeof bitmapTransfers;
  chartPixels: typeof chartPixels; rasterPixels: typeof rasterPixels;
  iconPixels: typeof iconPixels; mapPixels: typeof mapPixels; errors: string[];
  camera: (bearing: number) => void; restoreContext: () => void;
} } }
