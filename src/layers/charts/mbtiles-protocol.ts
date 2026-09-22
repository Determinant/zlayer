import { addProtocol, removeProtocol, type AddProtocolAction } from 'maplibre-gl';
import { transferHandlers, wrap, type Remote } from 'comlink';
import type { LazyHttpDatabase, SqliteComlinkMod } from 'sql.js-httpvfs/dist/sqlite.worker';
import sqliteWasmUrl from 'sql.js-httpvfs/dist/sql-wasm.wasm?url';
import sqliteWorkerUrl from 'sql.js-httpvfs/dist/sqlite.worker.js?url';

import { packageBoundsIntersect, type CatalogResponse, type ChartKind } from '@zlayer/contracts';

import { createMbtilesReader, type MbtilesReader, type TileCoordinate } from './mbtiles-reader';
import { ArchiveReaderPool } from './reader-pool';
import { createChartPackageIndex, tileBounds } from './package-index';
import { releasePackageDecoder, openPackageReader } from './package-loader';
import { MAX_FAST_PACKAGE_BYTES, MAX_RESIDENT_PACKAGES } from './package-reader';

import { regionalTileParts, renderRegionalTile } from './regional-tiles';
import { WorkerClient } from '../../core/data/worker-client';
import { renderRasterBitmap } from '../../core/graphics/raster-bitmap';
import { browsingCatalog, regionalBundles, type CatalogReadSource } from '../../workspace/read-context';

let packageIndexes = new WeakMap<CatalogResponse, ReturnType<typeof createChartPackageIndex>>();
const PROTOCOL = 'mbtiles';
const SQLITE_PAGE_SIZE = 4_096;
const archives = new Map<string, string>();
const readers = new ArchiveReaderPool(openReader);
const packages = new ArchiveReaderPool(openPackageReader, MAX_RESIDENT_PACKAGES);
let lifetime = new AbortController();
let packageArchive: ReturnType<typeof createChartPackageIndex> | undefined;
let installed = false;
let registeredCatalog: CatalogReadSource | undefined;
const failureListeners = new Set<(chartId: string) => void>();

const owners = new Set<symbol>();

/** Every chart adapter holds a lease, including adapters whose mount later fails. */
export function retainChartReaders(): () => void {
  const owner = Symbol();
  owners.add(owner);
  return () => {
    if (!owners.delete(owner) || owners.size) return;
    disposeMbtilesArchives();
  };
}

/** Also report partially rendered regional tiles: MapLibre sees those as successes. */
export function observeChartFailures(listener: (chartId: string) => void): () => void {
  failureListeners.add(listener);
  return () => { failureListeners.delete(listener); };
}
function reportChartFailure(chartId: string): void {
  for (const listener of failureListeners) listener(chartId);
}

export function registerMbtilesArchives(catalog: CatalogReadSource): void {
  if (registeredCatalog === catalog) return;
  if (lifetime.signal.aborted) lifetime = new AbortController();
  registeredCatalog = catalog;
  archives.clear();
  for (const chart of catalog.charts) archives.set(chart.id, chart.url);
  packageArchive = browsingCatalog(catalog).chartPackages ? createChartPackageIndex(browsingCatalog(catalog), document.baseURI) : undefined;
  if (installed) return;
  addProtocol(PROTOCOL, loadTile);
  installed = true;
}

/** Release map-owned memory and work; verified files remain in offline storage. */
function disposeMbtilesArchives(): void {
  lifetime.abort();
  readers.clear();
  packages.clear();
  releasePackageDecoder();
  archives.clear();
  packageArchive = undefined;
  packageIndexes = new WeakMap();
  registeredCatalog = undefined;
  if (installed) removeProtocol(PROTOCOL);
  installed = false;
}

export function mbtilesTileUrl(chartId: string): string {
  return `${PROTOCOL}://archive/${encodeURIComponent(chartId)}/{z}/{x}/{y}`;
}

const loadTile: AddProtocolAction = async ({ url }, abortController) => {
  const tile = parseTileUrl(url);
  const signal = AbortSignal.any([abortController.signal, lifetime.signal]);
  try { return await readTile(tile, signal); }
  catch (error) {
    signal.throwIfAborted();
    reportChartFailure(tile.chartId);
    throw error;
  }
};

async function readTile(tile: ReturnType<typeof parseTileUrl>, signal: AbortSignal) {
  signal.throwIfAborted();
  const family = tile.chartId.startsWith('@') ? tile.chartId.slice(1) as ChartKind : undefined;
  if (family && registeredCatalog && regionalBundles(registeredCatalog).length) {
    const parts = regionalTileParts(registeredCatalog, tile);
    return { data: await renderRegionalTile(parts, async catalog => {
      if (!catalog.chartPackages) return readLegacyFamily(catalog, family, tile, signal);
      let index = packageIndexes.get(catalog);
      if (!index && catalog.chartPackages) {
        index = createChartPackageIndex(catalog, document.baseURI);
        packageIndexes.set(catalog, index);
      }
      const archiveUrl = index?.(family, tile);
      if (!archiveUrl) return null;
      const pool = Number(new URL(archiveUrl).searchParams.get('bytes')) <= MAX_FAST_PACKAGE_BYTES ? packages : readers;
      return pool.use(archiveUrl, ({ read }) => read(tile, signal), signal);
    }, signal, () => reportChartFailure(tile.chartId)) };
  }
  const archiveUrl = family ? packageArchive?.(family, tile) : archives.get(tile.chartId);
  if (family && !archiveUrl) return { data: null };
  if (!archiveUrl) throw new Error(`Unknown MBTiles archive: ${tile.chartId}`);
  signal.throwIfAborted();
  const pool = family && Number(new URL(archiveUrl).searchParams.get('bytes')) <= MAX_FAST_PACKAGE_BYTES
    ? packages : readers;
  return pool.use(archiveUrl, async ({ read }) => ({ data: await read(tile, signal) }), signal);
}

/** A legacy browsing catalog can coexist with newer saved regional packages. */
async function readLegacyFamily(catalog: CatalogResponse, family: ChartKind, tile: TileCoordinate,
  signal: AbortSignal): Promise<ArrayBuffer | ImageBitmap | null> {
  const area = tileBounds(tile);
  const sheets = catalog.charts.filter(chart => chart.kind === family && packageBoundsIntersect(chart.bounds, area));
  const read = (url: string) => readers.use(new URL(url, document.baseURI).href,
    ({ read }) => read(tile, signal), signal);
  if (!sheets.length) return null;
  if (sheets.length === 1) return read(sheets[0]!.url);
  return renderRasterBitmap(256, signal, async context => {
    for (const sheet of sheets) {
      signal.throwIfAborted();
      const data = await read(sheet.url);
      if (!data) continue;
      const bitmap = data instanceof ArrayBuffer ? await createImageBitmap(new Blob([data])) : data;
      try { signal.throwIfAborted(); context.drawImage(bitmap, 0, 0, 256, 256); }
      finally { bitmap.close(); }
    }
  });
}

// Own the Worker handle so eviction really terminates its WASM heap and page
// cache. The library's convenience factory does not expose that handle.
const readerPorts = new WeakMap<object, MessagePort>();
transferHandlers.set('WORKERSQLPROXIES', {
  canHandle: (_value: unknown): _value is never => false,
  serialize: () => { throw new Error('SQL proxies are received only'); },
  deserialize: (port: MessagePort) => {
    port.start();
    const proxy = wrap(port);
    readerPorts.set(proxy, port);
    return proxy;
  },
});

async function openReader(url: string, signal: AbortSignal): Promise<{ read: MbtilesReader; dispose: () => void; isUsable: () => boolean }> {
  signal.throwIfAborted();
  const worker = new Worker(sqliteWorkerUrl);
  const client = new WorkerClient<SqliteComlinkMod>(worker, 'Unable to initialize chart archive reader');
  let db: Remote<LazyHttpDatabase> | undefined;
  const dispose = () => {
    signal.removeEventListener('abort', dispose);
    // Close transferred database ports too; a crashed worker cannot acknowledge RELEASE.
    if (db) readerPorts.get(db)?.close();
    client.dispose();
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    db = await client.call(remote => remote.SplitFileHttpDatabase(sqliteWasmUrl, [{
      from: 'inline',
      config: {
        serverMode: 'full',
        requestChunkSize: SQLITE_PAGE_SIZE,
        url,
      },
    }])) as unknown as Remote<LazyHttpDatabase>;
    signal.throwIfAborted();
    const read = await createMbtilesReader((sql, parameters) => client.call(() => db!.query(sql, parameters)));
    return { read, dispose, isUsable: () => !client.retired };
  } catch (error) { dispose(); throw error; }
}

function parseTileUrl(url: string): { chartId: string; z: number; x: number; y: number } {
  const parsed = new URL(url);
  const [encodedChartId, zValue, xValue, yValue, ...rest] = parsed.pathname
    .split('/')
    .filter(Boolean);
  const z = Number(zValue);
  const x = Number(xValue);
  const y = Number(yValue);
  if (
    parsed.hostname !== 'archive' || rest.length > 0 || !encodedChartId ||
    ![z, x, y].every(Number.isInteger) || z < 0 || z > 24 ||
    x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z
  ) {
    throw new Error(`Invalid MBTiles tile URL: ${url}`);
  }
  return { chartId: decodeURIComponent(encodedChartId), z, x, y };
}
