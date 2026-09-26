import { isRadarCatalog, RADAR_MAX_AGE, RADAR_MAX_BYTES, RADAR_HISTORY_MS, RADAR_HISTORY_STEP, RADAR_HISTORY_FILES, type RadarCatalog, type RadarFile, type RadarScan } from '@zlayer/contracts';
import type { WeatherCache } from './cache';
import { resourceFor, type Resource } from './routes';
import { digest } from './upstream';
import { workerJob, workerModule } from './worker-job';
import { WeatherSourceError } from './source-error';

export const PUBLISHED_RADAR = 'noaa-radar-contours-v2';
export const RADAR_SITES = 'TADW TATL TBNA TBOS TBWI TCLT TCMH TCVG TDAL TDAY TDCA TDEN TDFW TDTW TEWR TFLL THOU TIAD TIAH TICH TIDS TJFK TLAS TLVE TMCI TMCO TMDW TMEM TMIA TMKE TMSP TMSY TOKC TORD TDJT TPHL TPHX TPIT TRDU TSDF TSJU TSLC TSTL TTPA TTUL'.split(' ');
const ROOT = 'https://noaa-mrms-pds.s3.amazonaws.com/';
const PREFIX = 'CONUS/MergedReflectivityQCComposite_00.50/';
export const radarResource = () => resourceFor('/api/weather/radar/latest.json');
const inputResource = (url: string, listing = false): Resource => ({ key: url, url, upstream: 'radar', kind: listing ? 'radar-index' : 'radar-data',
  ttl: listing || url.endsWith('/sn.last') ? 60_000 : 86400_000, maxBytes: listing ? 256 * 1024 : 8 * 1024 * 1024 });
export const tdwrUrl = (site: string) => `https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.180z0/SI.${site.toLowerCase()}/sn.last`;

/** Only exact product keys from NOAA's bucket are eligible; truncated listings
 * fail instead of silently selecting an arbitrary older image. */
export function radarKeys(xml: string, day: string, now: number, maxAge = RADAR_HISTORY_MS): string[] {
  if (!xml.includes('<IsTruncated>false</IsTruncated>')) throw new Error('Incomplete MRMS listing');
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]!).filter(key => {
    const match = /^CONUS\/MergedReflectivityQCComposite_00\.50\/(\d{8})\/MRMS_MergedReflectivityQCComposite_00\.50_(\d{8})-(\d{2})(\d{2})(\d{2})\.grib2\.gz$/.exec(key);
    if (!match || match[1] !== day || match[2] !== day) return false;
    const time = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${match[3]}:${match[4]}:${match[5]}Z`);
    return time <= now + 60_000 && now - time < maxAge;
  }).sort();
  return keys;
}
export function radarKey(xml: string, day: string, now: number): string {
  const keys = radarKeys(xml, day, now, RADAR_MAX_AGE);
  if (!keys.length) throw new Error('No current MRMS composite');
  return keys.at(-1)!;
}
const keyTime = (key: string) => {
  const stamp = /_(\d{8})-(\d{2})(\d{2})(\d{2})\.grib2\.gz$/.exec(key)!;
  return Date.parse(`${stamp[1]!.slice(0, 4)}-${stamp[1]!.slice(4, 6)}-${stamp[1]!.slice(6)}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`);
};
/** Preserve the first retained scan per five-minute bucket. National history
 * gets priority; terminal detail uses the remaining bounded disk allowance. */
export function radarHistory(files: RadarFile[], now: number, maxBytes: number, size = (file: RadarFile) => file.byteLength): RadarFile[] {
  const buckets = new Map<string, RadarFile>();
  for (const file of [...files].sort((a, b) => a.observedAt - b.observedAt)) {
    if (file.observedAt < now - RADAR_HISTORY_MS || file.observedAt > now) continue;
    const key = `${file.site}/${Math.floor(file.observedAt / RADAR_HISTORY_STEP)}`;
    if (!buckets.has(key) || buckets.get(key)!.observedAt === file.observedAt) buckets.set(key, file);
  }
  let bytes = 0;
  return [...buckets.values()].sort((a, b) => Number(b.site === 'CONUS') - Number(a.site === 'CONUS') || b.observedAt - a.observedAt)
    .filter(file => { const length = size(file); if (bytes + length > maxBytes) return false; bytes += length; return true; })
    .slice(0, RADAR_HISTORY_FILES).sort((a, b) => a.observedAt - b.observedAt || a.site.localeCompare(b.site));
}
async function prepare(raw: Buffer, site: string, source: string, sourceHash: string, signal: AbortSignal,
  earliest: number, latest: number): Promise<{ body: Buffer; scan: RadarScan }> {
  const bytes = Uint8Array.from(raw).buffer;
  const result = await workerJob<{ body: ArrayBuffer; scan: RadarScan }>(
    workerModule(import.meta.url, 'radar-worker'),
    { raw: bytes, site, source, sourceHash, window: { earliest, latest } }, signal, [bytes]);
  return { body: Buffer.from(result.body), scan: result.scan };
}

/** National refresh has its own slot. The second slot checks terminals; history
 * borrows the national slot only while live work is not due, and is preemptible. */
export function createRadarWarming(cache: WeatherCache, signal: AbortSignal,
  options: { now?: () => number; log?: (message: string) => void; maxBytes?: number } = {}) {
  const now = options.now ?? Date.now;
  const historyBytes = Math.min(1024 * 1024 * 1024, (options.maxBytes ?? 4096 * 1024 * 1024) / 4);
  let catalog: RadarCatalog | undefined, nationalTask: Promise<void> | undefined, terminalTask: Promise<void> | undefined;
  let historyTask: Promise<void> | undefined, historyAbort: AbortController | undefined;
  let nextNational = 0, nextTerminals = 0, error: string | undefined, discovered: string[] = [];
  let clock = now();
  let publication = Promise.resolve();
  const latest = new Map<string, RadarFile>(), unavailable = new Set<string>(), added = new Map<string, RadarFile>();
  const retained = new Map<string, number>(), building = new Set<string>(), failures = new Map<string, string>();
  const rejected = new Map<string, { hash: string; until: number; error: Error }>();
  const historyFailures = new Set<string>();
  const resource = (file: Pick<RadarFile, 'path'>) => resourceFor(`/api/weather/radar/${file.path}`);
  const protect = () => {
    for (const [key, until] of retained) if (until <= now()) retained.delete(key);
    for (const [site, file] of latest) if (!cache.has(resource(file))) latest.delete(site);
    for (const [hash, file] of added) if (!cache.has(resource(file)) || now() - file.observedAt >= RADAR_HISTORY_MS) added.delete(hash);
    cache.retain([radarResource().key, ...[...(catalog?.files ?? []), ...(catalog?.history ?? []), ...latest.values(), ...added.values()]
      .filter(file => cache.has(resource(file))).map(file => resource(file).key), ...retained.keys(), ...building], 'radar');
  };
  protect();
  const report = (site: string, cause: unknown) => {
    const message = String(cause);
    if (failures.get(site) !== message) options.log?.(`Radar ${site}: ${message}`);
    failures.set(site, message);
  };
  async function source(site: string, work: AbortSignal, historicalUrl?: string): Promise<RadarFile> {
    let url = historicalUrl ?? tdwrUrl(site);
    const maxAge = historicalUrl ? RADAR_HISTORY_MS : RADAR_MAX_AGE;
    if (site === 'CONUS' && !historicalUrl) {
      discovered = [];
      const start = Math.floor((now() - RADAR_HISTORY_MS) / RADAR_HISTORY_STEP) * RADAR_HISTORY_STEP;
      const days = [...new Set([now(), start].map(time => new Date(time).toISOString().slice(0, 10).replaceAll('-', '')))];
      for (const day of days) {
        // A full daily listing grows beyond 256 KiB. S3 starts after our bounded
        // history window, keeping the same size ceiling throughout the UTC day.
        const lower = new Date(Math.max(start, Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T00:00:00Z`)));
        const after = `${PREFIX}${day}/MRMS_MergedReflectivityQCComposite_00.50_${day}-${lower.toISOString().slice(11, 19).replaceAll(':', '')}.grib2.gz`;
        const query = new URLSearchParams({ 'list-type': '2', prefix: `${PREFIX}${day}/`, 'start-after': after, 'max-keys': '1000' });
        try {
          const listing = await cache.get(inputResource(`${ROOT}?${query}`, true), undefined, work);
          discovered.push(...radarKeys(listing.body.toString(), day, now()));
          failures.delete(`listing ${day}`);
        } catch (cause) { work.throwIfAborted(); report(`listing ${day}`, cause); }
      }
      const key = discovered.sort().at(-1);
      if (!key || now() - keyTime(key) >= RADAR_MAX_AGE) throw new Error('No current MRMS composite');
      url = ROOT + key;
      for (const key of historyFailures) if (!discovered.includes(key)) historyFailures.delete(key);
    }
    const raw = await cache.get(inputResource(url), undefined, work);
    const old = [latest.get(site), ...(catalog?.history ?? [])].find(f => f?.site === site && f.source === url && f.sourceHash === raw.sha256);
    if (old && await cache.check(resource(old))) {
      if (now() - old.observedAt >= maxAge) throw new Error('Radar scan is too old');
      return old;
    }
    const rejection = rejected.get(site);
    if (!historicalUrl && rejection?.hash === raw.sha256 && rejection.until > now()) throw rejection.error;
    let result: Awaited<ReturnType<typeof prepare>>;
    try { result = await prepare(raw.body, site, url, raw.sha256, work, now() - maxAge, raw.checkedAt + 60_000); }
    catch (cause) {
      // Invalid bytes are deterministic; worker crashes/timeouts remain retryable.
      // Future timestamps are reconsidered after a new source check.
      if (!historicalUrl && cause instanceof WeatherSourceError) {
        rejected.set(site, { hash: raw.sha256, until: cause.code === 'future-source' ? now() + 60_000 : Infinity, error: cause });
      }
      throw cause;
    }
    const { body, scan } = result;
    if (scan.observedAt > raw.checkedAt + 60_000 || now() - scan.observedAt >= maxAge) throw new Error('Radar scan is too old or future dated');
    if (!historicalUrl && (latest.get(site)?.observedAt ?? 0) > scan.observedAt) throw new Error('Radar source moved backwards');
    const hash = digest(body), path = `${site}/${scan.observedAt}-${hash}.json`, output = resource({ path });
    building.add(output.key); protect();
    try {
      await cache.put(output, { body, sha256: hash, checkedAt: raw.checkedAt, status: 200,
        headers: { 'content-type': 'application/json', 'x-weather-artifact': PUBLISHED_RADAR } });
      const file = { ...scan, path, sha256: hash, byteLength: body.length };
      if (historicalUrl) added.set(hash, file); else latest.set(site, file);
      if (!historicalUrl) rejected.delete(site);
      return file;
    } finally { building.delete(output.key); protect(); }
  }
  function publish(sourceCheckedAt?: number): Promise<void> {
    const task = publication.catch(() => {}).then(async () => {
      const pruneAt = now(), checkedAt = sourceCheckedAt ?? pruneAt;
      const files = [...latest.values()].filter(file => cache.has(resource(file)));
      if (!files.some(file => file.site === 'CONUS')) return;
      const pending = [...added.values()];
      const history = radarHistory([...(catalog?.history ?? []), ...(catalog?.files ?? []), ...files, ...pending]
        .filter(file => cache.has(resource(file))), pruneAt, historyBytes, file => cache.storedSize(resource(file)));
      const next: RadarCatalog = { schemaVersion: 1, checkedAt, files: files.sort((a, b) => a.site.localeCompare(b.site)), unavailable: [...unavailable].sort(), history };
      if (!isRadarCatalog(next)) throw new Error('Invalid radar catalog');
      const body = Buffer.from(JSON.stringify(next));
      await cache.put(radarResource(), { body, sha256: digest(body), status: 200, checkedAt,
        headers: { 'content-type': 'application/json', 'x-weather-catalog': PUBLISHED_RADAR } });
      for (const file of [...(catalog?.files ?? []), ...(catalog?.history ?? [])]) retained.set(resource(file).key, now() + 6 * 60_000);
      for (const file of pending) added.delete(file.sha256);
      catalog = next; protect();
    });
    publication = task; return task;
  }
  async function updateNational() {
    nextNational = now() + 60_000;
    try {
      await historyTask;
      signal.throwIfAborted();
      latest.set('CONUS', await source('CONUS', signal));
      unavailable.delete('CONUS'); failures.delete('CONUS');
      await publish(); error = undefined;
    } catch (cause) {
      if (!signal.aborted) {
        unavailable.add('CONUS'); error = String(cause); report('CONUS', cause); nextNational = now() + 30_000;
        await publish().catch(cause => report('publication', cause));
      }
    } finally { protect(); }
  }
  async function updateTerminals() {
    try {
      for (const [index, site] of RADAR_SITES.entries()) {
        signal.throwIfAborted();
        try {
          latest.set(site, await source(site, signal)); unavailable.delete(site); failures.delete(site);
        } catch (cause) { signal.throwIfAborted(); unavailable.add(site); report(site, cause); }
        // Partial results become usable without waiting for the remaining stations.
        if (index % 5 === 4 || index === RADAR_SITES.length - 1) await publish();
      }
    } catch (cause) { if (!signal.aborted) report('terminals', cause); }
    finally { nextTerminals = now() + 60_000; protect(); }
  }
  async function backfill(work: AbortSignal) {
    for (let count = 0; count < 8 && !work.aborted && now() < nextNational; count++) {
      const buckets = new Set((catalog?.history ?? []).filter(f => f.site === 'CONUS').map(f => Math.floor(f.observedAt / RADAR_HISTORY_STEP)));
      const used = (catalog?.history ?? []).filter(f => f.site === 'CONUS').reduce((sum, f) => sum + cache.storedSize(resource(f)), 0);
      const composite = latest.get('CONUS');
      if (used + (composite ? cache.storedSize(resource(composite)) : RADAR_MAX_BYTES) > historyBytes) return;
      const key = [...discovered].reverse().find(key => !historyFailures.has(key) && !buckets.has(Math.floor(keyTime(key) / RADAR_HISTORY_STEP)));
      if (!key) return;
      try {
        await source('CONUS', work, ROOT + key); work.throwIfAborted(); await publish();
        if (!catalog?.history?.some(file => file.source === ROOT + key)) historyFailures.add(key);
      } catch (cause) { if (!work.aborted) { historyFailures.add(key); report('history', cause); } }
      finally { protect(); }
    }
  }
  return {
    async restore() {
      const saved = await cache.read(radarResource());
      if (!saved) return;
      try {
        const value: unknown = JSON.parse(saved.body.toString());
        if (saved.headers['x-weather-catalog'] !== PUBLISHED_RADAR || !isRadarCatalog(value) || value.checkedAt !== saved.checkedAt) throw new Error('Invalid saved radar');
        for (const file of value.files) if (await cache.check(resource(file))) latest.set(file.site, file);
        for (const file of value.history ?? []) await cache.check(resource(file));
        for (const site of value.unavailable) unavailable.add(site);
        if (!latest.has('CONUS')) throw new Error('Incomplete saved radar');
        catalog = value; protect(); nextNational = value.checkedAt + 60_000;
        if ([...value.files, ...(value.history ?? [])].some(file => !cache.has(resource(file)))) await publish(value.checkedAt);
      } catch { catalog = undefined; latest.clear(); unavailable.clear(); protect(); await cache.discard(radarResource()); }
    },
    refresh() {
      if (signal.aborted) return;
      if (now() < clock) { nextNational = nextTerminals = 0; rejected.clear(); historyFailures.clear(); }
      clock = now();
      protect();
      if (!nationalTask && now() >= nextNational) {
        historyAbort?.abort();
        nationalTask = updateNational().finally(() => { nationalTask = undefined; });
      } else if (!nationalTask && !historyTask && catalog) {
        historyAbort = new AbortController();
        historyTask = backfill(AbortSignal.any([signal, historyAbort.signal])).finally(() => { historyTask = undefined; historyAbort = undefined; });
      }
      if (!terminalTask && now() >= nextTerminals) terminalTask = updateTerminals().finally(() => { terminalTask = undefined; });
    },
    get status() { return { ready: !!catalog && cache.has(radarResource()) && catalog.files.some(file => file.site === 'CONUS' && cache.has(resource(file))), preparing: !!nationalTask || !!terminalTask || !!historyTask,
      checkedAt: catalog?.checkedAt, scans: catalog?.files.length ?? 0, historyScans: catalog?.history?.length ?? 0,
      unavailable: catalog?.unavailable, ...(error ? { error } : {}) }; },
    async close() { await Promise.allSettled([nationalTask, terminalTask, historyTask]); await publication.catch(() => {}); },
  };
}
