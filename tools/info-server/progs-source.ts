import type { createSourceEvidence } from './source-evidence';
import { isOlderSurfaceCatalog, parseSurfaceCatalog, SURFACE_CATALOG, type SurfaceChart } from '../../src/layers/weather-awc/progs/source';
import type { WeatherCache } from './cache';
import { HttpError, type Resource } from './weather-resources';

export function progsSourceResource(url: string, maxBytes: number, image = false): Resource {
  return { key: url, url, upstream: 'awc', kind: image ? 'coverage-image' : 'surface',
    ttl: 5 * 60_000, maxBytes, revalidate: true };
}

/** All Progs families share acquisition and quarantine, while each validates
 * against its own published horizon. A rejected observation cannot occupy the
 * positive source cache through several nominal recovery attempts. */
export async function readProgsCatalog(cache: WeatherCache, signal: AbortSignal,
  product: 'analysis' | 'forecast' | 'coverage', previous: readonly Pick<SurfaceChart, 'validTime' | 'referenceTime'>[], evidence?: ReturnType<typeof createSourceEvidence>) {
  const resource = progsSourceResource(SURFACE_CATALOG, 16 * 1024);
  const payload = await cache.get(resource, 150_000, signal);
  let charts: SurfaceChart[];
  const capture = async (rule: string) => evidence?.capture(payload.body, { source: resource.url, requestedAt: payload.checkedAt,
    checkedAt: payload.checkedAt, headers: payload.headers, phase: 'catalog-validation', rule });
  try { charts = parseSurfaceCatalog(payload.body.toString('utf8'), payload.checkedAt); }
  catch (cause) {
    const error = new HttpError(502, cause instanceof Error ? cause.message : 'Invalid surface catalog', 30);
    await capture(error.message); await cache.reject(resource, payload, error); throw error;
  }
  // An absent analysis cannot invalidate independently listed forecasts. Keep
  // the shared observation cached; qualify the affected family explicitly.
  if (product !== 'forecast' && !charts.some(chart => chart.forecastHour === 0)) {
    await capture('AWC catalog has no surface analysis');
    throw new HttpError(502, 'AWC catalog has no surface analysis', 30);
  }
  charts = charts.filter(chart => product === 'coverage' || (product === 'analysis' ? chart.forecastHour === 0 : chart.forecastHour > 0));
  if (!charts.length) throw new HttpError(502, 'AWC catalog has no surface forecasts', 30);
  if (isOlderSurfaceCatalog(charts, previous)) {
    const error = new HttpError(502, product === 'coverage' ? 'NOAA returned older NDFD coverage charts' : 'NOAA returned older surface charts', 30);
    await capture(error.message); await cache.reject(resource, payload, error); throw error;
  }
  return { payload, charts };
}
