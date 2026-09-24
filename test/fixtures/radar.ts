import { RADAR_LEVELS, type RadarCatalog, type RadarContours } from '@zlayer/contracts';
import { digest } from '../../tools/weather-server/upstream';
import { PUBLISHED_RADAR, tdwrUrl } from '../../tools/weather-server/radar';
import { resourceFor } from '../../tools/weather-server/routes';
import type { WeatherCache } from '../../tools/weather-server/cache';
import { WEATHER_NOW } from './awc-advisories';

export function radarFixture(now = WEATHER_NOW, history = false) {
  const files = new Map<string, Buffer>();
  const catalog: RadarCatalog = { schemaVersion: 1, checkedAt: now, unavailable: [], files: [], ...(history ? { history: [] } : {}) };
  for (const minutesAgo of history ? [92, 62, 32, 12, 0] : [0]) for (const site of ['CONUS', 'TOKC']) {
    const observedAt = now - (minutesAgo + (site === 'CONUS' ? 2 : 4)) * 60_000;
    const stamp = new Date(observedAt).toISOString().replaceAll('-', '').replaceAll(':', '');
    const box: [number, number, number, number] = site === 'CONUS' ? [-130, 20, -60, 55] : [-124, 36, -121, 39];
    const value: RadarContours = { schemaVersion: 1, site, observedAt, sourceHash: 'a'.repeat(64), bounds: box,
      source: site === 'CONUS' ? `https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MergedReflectivityQCComposite_00.50/${stamp.slice(0, 8)}/MRMS_MergedReflectivityQCComposite_00.50_${stamp.slice(0, 8)}-${stamp.slice(9, 15)}.grib2.gz` : tdwrUrl(site),
      type: 'FeatureCollection', features: RADAR_LEVELS.map((dbz, i) => {
        const inset = i * .06, x = (site === 'CONUS' ? -122.3 : -122.13) + minutesAgo / 300;
        return { type: 'Feature', properties: { dbz }, geometry: { type: 'MultiPolygon', coordinates: i > (site === 'CONUS' ? 4 : 5) ? []
          : [[[[x + inset, 37.05 + inset], [x + .9 - inset, 37.05 + inset], [x + .9 - inset, 37.95 - inset], [x + inset, 37.95 - inset], [x + inset, 37.05 + inset]]]] } };
      }) };
    const body = Buffer.from(JSON.stringify(value)), sha256 = digest(body), path = `${site}/${observedAt}-${sha256}.json`;
    files.set(path, body); (minutesAgo ? catalog.history! : catalog.files).push({ site, observedAt, source: value.source, sourceHash: value.sourceHash, bounds: box, path, sha256, byteLength: body.length });
  }
  return { catalog, files };
}
export async function seedRadar(cache: WeatherCache) {
  const { catalog, files } = radarFixture(WEATHER_NOW, true);
  for (const [path, body] of files) await cache.put(resourceFor(`/api/weather/radar/${path}`), { body, checkedAt: WEATHER_NOW, sha256: digest(body), status: 200,
    headers: { 'content-type': 'application/json', 'x-weather-artifact': PUBLISHED_RADAR } });
  const body = Buffer.from(JSON.stringify(catalog));
  await cache.put(resourceFor('/api/weather/radar/latest.json'), { body, checkedAt: WEATHER_NOW, sha256: digest(body), status: 200,
    headers: { 'content-type': 'application/json', 'x-weather-catalog': PUBLISHED_RADAR } });
}
