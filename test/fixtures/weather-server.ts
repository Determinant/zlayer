import { resourceFor } from '../../tools/weather-server/routes';
import { forecastResource, terrainResource } from '../../tools/weather-server/processing';
import type { AwcGridProduct } from '@zlayer/contracts';
import type { NativeFrame, NativeManifest } from '../../src/layers/weather-awc/grids/native-source';
import { createWeatherServer } from '../../tools/weather-server/server';
import { PUBLISHED_CATALOG } from '../../tools/weather-server/warming';
import { nativeForecastFiles } from './awc-native.mjs';
import { advisorySource, WEATHER_NOW } from './awc-advisories';
import { coveragePng } from './progs-coverage';
import { surfaceCatalog, surfaceChart } from './wpc';

import { seedRadar } from './radar';
const files = nativeForecastFiles();
const coverage = coveragePng();
export async function fixtureWeather(directory: string, options: { onRaw?: (signal: AbortSignal | undefined, path: string) => void | Promise<void>;
  advisories?: () => { failure?: boolean; gairmet: unknown[]; sigmet: unknown; cwa: unknown } | undefined } = {}) {
  const app = await createWeatherServer({ directory, spacing: 0, now: () => WEATHER_NOW, startUpdates: false, log: message => console.error(message),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/data/progchart') return Response.json(surfaceCatalog());
      if (url.pathname.endsWith('_ndfd_sfc_wx_m.png')) return url.pathname.includes('_F168_')
        ? new Response(null, { status: 404 }) : new Response(coverage, { headers: { 'content-type': 'image/png' } });
      if (url.pathname.startsWith('/data/products/wpc/')) return Response.json(surfaceChart(url.pathname.split('/').pop()!));
      if (url.hostname === 'aviationweather.gov') {
        const product = url.pathname.split('/').pop()!;
        const data = options.advisories ? options.advisories() : { gairmet: [0, 3, 6, 9, 12].map(h => advisorySource('gairmet', h)),
          sigmet: advisorySource('sigmet'), cwa: advisorySource('cwa') };
        if (!data || data.failure) return new Response(null, { status: 503 });
        return Response.json(product === 'gairmet' ? data.gairmet[Number(url.searchParams.get('fore') ?? 0) / 3]
          : product === 'airsigmet' ? data.sigmet : data.cwa);
      }
      const path = url.hostname === 'storage.googleapis.com' ? '/weather/noaa/hrrr/prod/' + url.pathname.replace('/high-resolution-rapid-refresh/', '')
        : url.pathname.replace('/pub/data/nccf/com/', '/weather/noaa/');
      const file = files.get(path);
      if (!file) return new Response(null, { status: 404 });
      const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get('range') ?? '');
      if (path.endsWith('.grib2')) await options.onRaw?.(init?.signal ?? undefined, path);
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : file.length - 1;
      return new Response(Uint8Array.from(file.subarray(start, end + 1)), { status: range ? 206 : 200,
        headers: { 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}) } });
    } });
  async function warmForecast(product: AwcGridProduct, select: (manifest: NativeManifest) => NativeFrame[]) {
    const catalog = await app.processing.catalog(product);
    const manifest = JSON.parse(catalog.body.toString()) as NativeManifest;
    const frames = select(manifest);
    if (product === 'winds' && frames.length && !app.cache.has(terrainResource(manifest, frames[0]!))) await app.cache.put(terrainResource(manifest, frames[0]!),
      await app.processing.forecast(manifest, frames[0]!, true));
    for (const frame of frames) {
      const resource = forecastResource(manifest, frame);
      if (!app.cache.has(resource)) await app.cache.put(resource, await app.processing.forecast(manifest, frame));
    }
    // Fixtures publish only the selected numeric samples exercised by the caller.
    await app.cache.put(resourceFor(`/api/weather/grids/${product}.json`), { ...catalog,
      headers: { ...catalog.headers, 'x-weather-catalog': PUBLISHED_CATALOG } });
    return manifest;
  }
  async function warmAdvisories() {
    for (const product of ['gairmet', 'sigmet', 'cwa']) {
      await app.cache.get(resourceFor(`/api/weather/advisories/${product}.json`));
    }
  }
  async function warmProgs() {
    app.progs.refresh(); app.coverage.refresh();
    await Promise.all([app.progs.close(), app.coverage.close()]);
  }
  return { ...app, warmForecast, warmAdvisories, warmProgs, warmRadar: () => seedRadar(app.cache) };
}
