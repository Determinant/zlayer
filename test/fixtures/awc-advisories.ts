import type { AwcAdvisoryProduct } from '@zlayer/contracts';
import { normalizeAdvisories, FORECAST_HOURS, type SourceCollection } from '../../src/layers/weather-awc/source';

export const WEATHER_NOW = Date.parse('2026-09-22T21:00:00Z');
const polygon = { type: 'Polygon' as const, coordinates: [[[-124, 35], [-120, 35], [-120, 40], [-124, 40], [-124, 35]]] };
const feature = (properties: Record<string, unknown>) => ({ type: 'Feature' as const, properties, geometry: polygon });

/** Deliberately synthetic, spanning the default map view for picking tests. */
export function advisorySource(product: AwcAdvisoryProduct, hour = 0, base = WEATHER_NOW): SourceCollection {
  const from = new Date(base).toISOString(), to = new Date(base + 2 * 3_600_000).toISOString();
  return { type: 'FeatureCollection', features: product === 'gairmet' ? [feature({ product: 'ZULU',
    hazard: 'ICE', tag: `ICE-${hour}`, issueTime: from, validTime: new Date(base + hour * 3_600_000).toISOString(),
    forecast: hour, base: 'FZL', top: '250', fzlbase: '080', fzltop: '120', dueTo: 'SYNTHETIC ICING TEST' }),
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-124, 37], [-120, 37]] }, properties: {
      product: 'ZULU', hazard: 'FZLVL', tag: `FZ-${hour}`, issueTime: from, validTime: new Date(base + hour * 3_600_000).toISOString(),
      forecast: hour, level: '120',
    } }]
    : product === 'sigmet' ? ['CONVECTIVE', 'TURB'].map((hazard, index) => feature({ hazard, icaoId: 'KKCI',
      airSigmetType: 'SIGMET', seriesId: `${index + 1}W`, validTimeFrom: from, validTimeTo: to,
      altitudeLow1: null, altitudeHi1: 45000, altitudeHi2: 60000, rawAirSigmet: `SYNTHETIC ${hazard} SIGMET TEST. TOPS ABV FL450.` }))
    : [feature({ cwsu: 'ZOA', seriesId: '101', hazard: 'TS', top: 33000, validTimeFrom: from,
      validTimeTo: to, cwaText: 'SYNTHETIC CWA TEST' })] };
}
export function advisorySnapshot(product: AwcAdvisoryProduct, now = WEATHER_NOW) {
  return normalizeAdvisories(product, (product === 'gairmet' ? FORECAST_HOURS : [0]).map(hour => advisorySource(product, hour, now)),
    now, 'https://aviationweather.gov/api/data/');
}
