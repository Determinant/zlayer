import { isProgsCoverageCatalog, progsCoverageSource, PROGS_COVERAGE_SOURCE, PROGS_COVERAGE_MAX_BYTES,
  type ProgsCoverageCatalog, type ProgsCoverageFrame, type ProgsCoverageFile } from '@zlayer/contracts';
import { parseSurfaceCatalog } from '../../src/layers/weather-awc/progs/source';
import type { WeatherCache } from './cache';
import { HttpError, resourceFor, type Resource } from './routes';
import { digest, type Payload } from './upstream';
import { workerJob, workerModule } from './worker-job';

export const PUBLISHED_COVERAGE = 'awc-ndfd-png-v1';
const catalogResource = () => resourceFor('/api/weather/progs/coverage.json');
const imageResource = (file: ProgsCoverageFile) => resourceFor(`/api/weather/progs/${file.path}`);
const sourceResource = (url: string, image = false): Resource => ({ key: url, url, upstream: 'awc',
  kind: image ? 'coverage-image' : 'surface', ttl: 5 * 60_000, maxBytes: image ? PROGS_COVERAGE_MAX_BYTES : 16 * 1024 });

/** Coverage may be unpublished at a chart stop. Keep those gaps explicit;
 * failures other than 404 retain the preceding authenticated catalog. */
export function createProgsCoverageWarming(cache: WeatherCache, signal: AbortSignal,
  options: { now?: () => number; log?: (message: string) => void } = {}) {
  const now = options.now ?? Date.now;
  let catalog: ProgsCoverageCatalog | undefined, task: Promise<void> | undefined, nextCheck = 0, error: string | undefined;
  const building = new Set<string>(), retained = new Map<string, number>();
  const protect = () => {
    for (const [key, until] of retained) if (until <= now()) retained.delete(key);
    cache.retain([catalogResource().key, ...building, ...retained.keys(),
      ...(catalog?.frames.flatMap(frame => frame.file ? [imageResource(frame.file).key] : []) ?? [])], 'progs-coverage');
  };
  protect();
  async function update() {
    try {
      const input = await cache.get(sourceResource(PROGS_COVERAGE_SOURCE), 150_000, signal);
      const charts = parseSurfaceCatalog(input.body.toString('utf8'), input.checkedAt);
      const frames: ProgsCoverageFrame[] = [], changed: { file: ProgsCoverageFile; payload: Payload }[] = [];
      for (const chart of charts) {
        const source = progsCoverageSource(chart.validTime, chart.referenceTime);
        const frame: ProgsCoverageFrame = { validTime: chart.validTime, chartReferenceTime: chart.referenceTime, source, checkedAt: now() };
        try {
          const image = await cache.get(sourceResource(source, true), 150_000, signal);
          const file = { path: `coverage/${image.sha256}.png`, sha256: image.sha256, byteLength: image.body.length };
          frame.checkedAt = image.checkedAt; frame.file = file;
          if (!catalog?.frames.some(previous => previous.file?.sha256 === file.sha256) || !await cache.check(imageResource(file))) {
            changed.push({ file, payload: image });
          }
        } catch (cause) { if (!(cause instanceof HttpError) || cause.status !== 404) throw cause; }
        frames.push(frame);
      }
      const next: ProgsCoverageCatalog = { schemaVersion: 1, source: PROGS_COVERAGE_SOURCE, sourceHash: input.sha256,
        sourceCatalog: input.body.toString('utf8'), checkedAt: Math.min(input.checkedAt, ...frames.map(frame => frame.checkedAt)), frames };
      if (!isProgsCoverageCatalog(next)) throw new Error('Invalid NDFD coverage catalog');
      if (catalog && (frames[0]!.validTime < catalog.frames[0]!.validTime || frames.at(-1)!.validTime < catalog.frames.at(-1)!.validTime ||
        frames.some(frame => catalog!.frames.some(old => old.validTime === frame.validTime && old.chartReferenceTime > frame.chartReferenceTime)))) {
        throw new Error('NOAA returned older NDFD coverage charts');
      }
      if (changed.length) await workerJob(workerModule(import.meta.url, 'progs-coverage-worker'),
        changed.map(image => image.payload.body), signal);
      for (const { file, payload } of changed) {
        signal.throwIfAborted();
        const resource = imageResource(file); building.add(resource.key); protect();
        await cache.put(resource, { ...payload, headers: { 'content-type': 'image/png', 'x-weather-artifact': PUBLISHED_COVERAGE } });
      }
      const body = Buffer.from(JSON.stringify(next));
      await cache.put(catalogResource(), { body, status: 200, checkedAt: next.checkedAt, sha256: digest(body),
        headers: { 'content-type': 'application/json', 'x-weather-catalog': PUBLISHED_COVERAGE } });
      for (const frame of catalog?.frames ?? []) if (frame.file) retained.set(imageResource(frame.file).key, now() + 10 * 60_000);
      catalog = next; error = undefined; nextCheck = now() + 5 * 60_000;
    } catch (cause) {
      if (signal.aborted) return;
      error = cause instanceof Error ? cause.message : String(cause); nextCheck = now() + 30_000;
      options.log?.(`NDFD coverage update failed: ${error}`);
    } finally { building.clear(); protect(); }
  }
  return {
    async restore() {
      const resource = catalogResource(), saved = await cache.read(resource);
      if (!saved) return;
      let value: unknown;
      try { value = JSON.parse(saved.body.toString('utf8')); } catch { /* Invalid saved catalog. */ }
      if (saved.headers['x-weather-catalog'] === PUBLISHED_COVERAGE && isProgsCoverageCatalog(value) &&
        value.checkedAt === saved.checkedAt && await cache.checkAll(value.frames.flatMap(frame => frame.file ? [imageResource(frame.file)] : []))) {
        catalog = value; nextCheck = value.checkedAt + 5 * 60_000; protect();
      } else await cache.discard(resource);
    },
    refresh() { if (!signal.aborted && !task && now() >= nextCheck) task = update().finally(() => { task = undefined; }); },
    get status() { return { ready: !!catalog && cache.has(catalogResource()) && catalog.frames.every(frame => !frame.file || cache.has(imageResource(frame.file))), preparing: !!task, checkedAt: catalog?.checkedAt,
      validTimes: catalog?.frames.filter(frame => frame.file).map(frame => frame.validTime),
      unavailableTimes: catalog?.frames.filter(frame => !frame.file).map(frame => frame.validTime), ...(error ? { error } : {}) }; },
    async close() { await task; },
  };
}
