import { isOlderSurfaceCatalog, parseSurfaceCatalog, SURFACE_CATALOG, type SurfaceChart } from '../../src/layers/weather-awc/progs/source';
import type { WeatherCache } from './cache';
import { HttpError, type Resource } from './routes';

export function progsSourceResource(url: string, maxBytes: number, image = false): Resource {
  return { key: url, url, upstream: 'awc', kind: image ? 'coverage-image' : 'surface',
    ttl: 5 * 60_000, maxBytes, revalidate: true };
}

/** All Progs families share acquisition and quarantine, while each validates
 * against its own published horizon. A rejected observation cannot occupy the
 * positive source cache through several nominal recovery attempts. */
export async function readProgsCatalog(cache: WeatherCache, signal: AbortSignal,
  product: 'analysis' | 'forecast' | 'coverage', previous: readonly Pick<SurfaceChart, 'validTime' | 'referenceTime'>[]) {
  const resource = progsSourceResource(SURFACE_CATALOG, 16 * 1024);
  const payload = await cache.get(resource, 150_000, signal);
  try {
    const charts = parseSurfaceCatalog(payload.body.toString('utf8'), payload.checkedAt)
      .filter(chart => product === 'coverage' || (product === 'analysis' ? chart.forecastHour === 0 : chart.forecastHour > 0));
    if (!charts.length) throw new Error('No published surface charts');
    if (isOlderSurfaceCatalog(charts, previous)) throw new Error(product === 'coverage'
      ? 'NOAA returned older NDFD coverage charts' : 'NOAA returned older surface charts');
    return { payload, charts };
  } catch (cause) {
    const error = new HttpError(502, cause instanceof Error ? cause.message : 'Invalid surface catalog', 30);
    await cache.reject(resource, payload, error);
    throw error;
  }
}
