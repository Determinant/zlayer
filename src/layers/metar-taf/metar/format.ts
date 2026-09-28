import type { GeoPointProperties } from '@zlayer/contracts';
import { formatDataAge, formatTimestamp } from '../../../core/format/time';
import { magneticBearing } from '../../../core/geo/magnetic-model';

export function formatMetarAge(isoTime: string | undefined): string {
  if (!isoTime) return 'METAR';
  return `METAR · ${formatDataAge(isoTime)}`;
}

export function minutesSince(isoTime: string): number | undefined {
  const observedAt = Date.parse(isoTime);
  return Number.isFinite(observedAt)
    ? Math.max(0, Math.floor((Date.now() - observedAt) / 60_000))
    : undefined;
}

export function formatObservationTime(value: string | undefined, now = Date.now()): string {
  return formatTimestamp(value, { now });
}

/** Read only the coded report body, preserving its published pressure unit. */
export function formatMetarAltimeter(raw: string | undefined): string | undefined {
  const group = raw?.split(/\bRMK\b/)[0]?.match(/(?:^|\s)([AQ])(\d{4})(?=\s|=|$)/);
  if (!group || Number(group[2]) === 0) return undefined;
  return group[1] === 'A' ? `${(Number(group[2]) / 100).toFixed(2)} inHg` : `${Number(group[2])} hPa`;
}

export function formatMetarWind(properties: GeoPointProperties, declination?: number | null): string | undefined {
  const speed = properties.metarWindSpeedKt;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) return undefined;
  const reportedGust = properties.metarWindGustKt;
  const gust = typeof reportedGust === 'number' && Number.isFinite(reportedGust) && reportedGust > speed
    ? `G${reportedGust}` : '';
  if (speed === 0 && !gust) return 'Calm';
  const direction = properties.metarWindDirection;
  const numeric = typeof direction === 'string' && /^\d{1,3}$/.test(direction.trim())
    ? Number(direction) : direction;
  const bearing = (degrees: number) => String(Math.round(degrees) % 360 || 360).padStart(3, '0');
  const label = typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0 && numeric <= 360
    ? `${typeof declination === 'number' && Number.isFinite(declination)
      ? `${bearing(magneticBearing(numeric, declination))}°M` : '—'}/${bearing(numeric)}°T`
    : typeof direction === 'string' && direction.trim().toUpperCase() === 'VRB'
    ? 'VRB' : 'Direction unavailable ·';
  return `${label} ${speed}${gust} kt`;
}
