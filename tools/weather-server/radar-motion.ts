import { isRadarMotionCatalog, isRadarMotionSnapshot, RADAR_HISTORY_MS, RADAR_HISTORY_STEP, RADAR_MAX_AGE,
  RADAR_MOTION_MAX_BYTES, RADAR_MOTION_ROOT, type RadarMotionCatalog, type RadarMotionFile, type RadarMotionScan } from '@zlayer/contracts';
import type { WeatherCache } from './cache';
import { resourceFor, type Resource } from './routes';
import { digest } from './upstream';
import { decodeStormTracks } from './radar-motion-decode';

export const PUBLISHED_MOTION = 'noaa-storm-tracks-v1';
const catalogResource = () => resourceFor('/api/weather/radar/motion/latest.json');
const fileResource = (file: Pick<RadarMotionFile, 'path'>) => resourceFor(`/api/weather/radar/${file.path}`);
const input = (url: string, listing = false): Resource => ({ key: url, url, upstream: 'radar', kind: listing ? 'radar-index' : 'radar-data',
  ttl: listing ? 86400_000 : 120_000, maxBytes: listing ? 64 * 1024 : 512 * 1024 });

/** Small STI files have their own sequential background collector. They share
 * source admission and disk accounting, never either reflectivity worker slot. */
export function createRadarMotionWarming(cache: WeatherCache, signal: AbortSignal,
  options: { now?: () => number; log?: (message: string) => void; maxBytes?: number } = {}) {
  const now = options.now ?? Date.now, budget = Math.min(64 * 1024 * 1024, (options.maxBytes ?? 4096 * 1024 * 1024) / 64);
  let catalog: RadarMotionCatalog | undefined, task: Promise<void> | undefined, next = 0, clock = now(), error: string | undefined;
  let prepared: { identity: string; file: RadarMotionFile } | undefined;
  const scans = new Map<string, RadarMotionScan>(), unavailable = new Set<string>(), retained = new Map<string, number>(), building = new Set<string>();
  const rejected = new Map<string, string>();
  const protect = () => {
    for (const [key, until] of retained) if (until <= now()) retained.delete(key);
    cache.retain([catalogResource().key, ...(catalog?.files ?? []).filter(f => cache.has(fileResource(f))).map(f => fileResource(f).key),
      ...retained.keys(), ...building], 'radar-motion');
  };
  async function publish() {
    const checkedAt = now();
    const current = [...scans.values()].filter(s => s.observedAt <= checkedAt && checkedAt - s.observedAt < RADAR_MAX_AGE).sort((a, b) => a.site.localeCompare(b.site));
    let files = (catalog?.files ?? []).filter(f => f.availableAt <= checkedAt && checkedAt - f.availableAt <= RADAR_HISTORY_MS && cache.has(fileResource(f)));
    if (current.length) {
      const identity = current.map(s => `${s.site}/${s.sourceHash}`).join('|');
      let file = prepared?.identity === identity && cache.has(fileResource(prepared.file)) ? prepared.file : undefined;
      if (!file) {
        const snapshot = { schemaVersion: 1 as const, scans: current };
        const body = Buffer.from(JSON.stringify(snapshot)), sha256 = digest(body);
        if (!isRadarMotionSnapshot(snapshot) || body.length > RADAR_MOTION_MAX_BYTES) throw new Error('Storm motion snapshot exceeds its bounds');
        file = { availableAt: checkedAt, path: `motion/${sha256}.json`, sha256, byteLength: body.length };
        const resource = fileResource(file);
        building.add(resource.key); protect();
        if (!cache.has(resource)) await cache.put(resource, { body, sha256, checkedAt, status: 200, headers: { 'content-type': 'application/json', 'x-weather-artifact': PUBLISHED_MOTION } });
        prepared = { identity, file };
      }
      if (files.at(-1)?.sha256 !== file.sha256) {
        files = files.filter(f => f.availableAt !== checkedAt);
        files.push({ ...file, availableAt: checkedAt });
      }
    }
    // Preserve one stable snapshot per five-minute bucket and the latest one.
    const latest = files.at(-1), buckets = new Set<number>();
    files = files.filter(f => {
      const bucket = Math.floor(f.availableAt / RADAR_HISTORY_STEP), keep = !buckets.has(bucket) || f === latest;
      buckets.add(bucket); return keep;
    });
    let bytes = 0;
    files = files.reverse().filter((f, i) => {
      const size = cache.storedSize(fileResource(f));
      if (i && bytes + size > budget) return false;
      bytes += size; return true;
    }).slice(0, 26).reverse();
    const updated: RadarMotionCatalog = { schemaVersion: 1, checkedAt, files, unavailable: [...unavailable].sort() };
    if (!isRadarMotionCatalog(updated)) throw new Error('Invalid storm motion catalog');
    const body = Buffer.from(JSON.stringify(updated));
    await cache.put(catalogResource(), { body, sha256: digest(body), checkedAt, status: 200,
      headers: { 'content-type': 'application/json', 'x-weather-catalog': PUBLISHED_MOTION } });
    for (const file of catalog?.files ?? []) retained.set(fileResource(file).key, checkedAt + 6 * 60_000);
    catalog = updated; building.clear(); protect();
  }
  async function update() {
    try {
      const listing = await cache.get(input(RADAR_MOTION_ROOT, true), undefined, signal);
      const text = listing.body.toString();
      if (!text.trimEnd().endsWith('</html>')) throw new Error('Incomplete NOAA storm tracking station listing');
      const sites = [...new Set([...text.matchAll(/href="SI\.(k[a-z]{3})\//g)].map(m => m[1]!.toUpperCase()))].sort();
      if (!sites.length || sites.length > 160) throw new Error('Invalid NOAA storm tracking station listing');
      for (const site of scans.keys()) if (!sites.includes(site)) scans.delete(site);
      for (const site of unavailable) if (!sites.includes(site)) unavailable.delete(site);
      for (const [index, site] of sites.entries()) {
        signal.throwIfAborted();
        try {
          const raw = await cache.get(input(`${RADAR_MOTION_ROOT}SI.${site.toLowerCase()}/sn.last`), undefined, signal);
          const old = scans.get(site);
          if (rejected.get(site) === raw.sha256) throw new Error('Unchanged invalid storm tracking product');
          let scan = old?.sourceHash === raw.sha256 ? old : undefined;
          if (!scan) {
            try { scan = decodeStormTracks(raw.body, site, raw.sha256); }
            catch (cause) { rejected.set(site, raw.sha256); throw cause; }
          }
          if (scan.observedAt > raw.checkedAt + 60_000 || now() - scan.observedAt >= RADAR_MAX_AGE || (old?.observedAt ?? 0) > scan.observedAt) {
            throw new Error('Storm tracking scan is old, future dated or moved backwards');
          }
          scans.set(site, scan); unavailable.delete(site); rejected.delete(site);
        } catch { signal.throwIfAborted(); unavailable.add(site); }
        // Make regional results usable without waiting for all national stations.
        if (index % 25 === 24 || index === sites.length - 1) await publish();
      }
      error = undefined; next = now() + 120_000;
    } catch (cause) {
      if (!signal.aborted) {
        const message = String(cause);
        if (message !== error) options.log?.(`Radar storm motion: ${message}`);
        error = message; next = now() + 60_000;
      }
    } finally { building.clear(); protect(); }
  }
  protect();
  return {
    async restore() {
      const saved = await cache.read(catalogResource());
      if (!saved) return;
      try {
        const value: unknown = JSON.parse(saved.body.toString());
        if (saved.headers['x-weather-catalog'] !== PUBLISHED_MOTION || !isRadarMotionCatalog(value) || value.checkedAt !== saved.checkedAt || value.checkedAt > now() + 60_000) throw new Error('Invalid saved storm motion');
        catalog = value; protect();
        const latest = value.files.at(-1), data = latest && await cache.read(fileResource(latest));
        if (data && latest) {
          const snapshot: unknown = JSON.parse(data.body.toString());
          if (data.sha256 === latest.sha256 && isRadarMotionSnapshot(snapshot)) for (const scan of snapshot.scans) if (scan.observedAt <= now()) scans.set(scan.site, scan);
        }
        for (const site of value.unavailable) unavailable.add(site);
      } catch { catalog = undefined; scans.clear(); await cache.discard(catalogResource()); protect(); }
    },
    refresh() {
      if (signal.aborted) return;
      if (now() < clock) { next = 0; scans.clear(); rejected.clear(); prepared = undefined; }
      clock = now(); protect();
      if (!task && now() >= next) task = update().finally(() => { task = undefined; });
    },
    get status() { return { ready: !!catalog && cache.has(catalogResource()), preparing: !!task, checkedAt: catalog?.checkedAt,
      stations: scans.size, unavailable: catalog?.unavailable.length ?? 0, ...(error ? { error } : {}) }; },
    async close() { await task; },
  };
}
