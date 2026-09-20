import type { GeoPointProperties } from '@zlayer/contracts';
import { formatDataAge, formatTimestamp } from '../../../core/format/time';

export function formatMetarAge(isoTime: string | undefined): string {
  if (!isoTime) return 'AWC';
  return `AWC · ${formatDataAge(isoTime)}`;
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

export function formatMetarWind(properties: GeoPointProperties): string | undefined {
  const speed = properties.metarWindSpeedKt;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) return undefined;
  const reportedGust = properties.metarWindGustKt;
  const gust = typeof reportedGust === 'number' && Number.isFinite(reportedGust) && reportedGust > speed
    ? `G${reportedGust}` : '';
  if (speed === 0 && !gust) return 'Calm';
  const direction = properties.metarWindDirection;
  const numeric = typeof direction === 'string' && /^\d{1,3}$/.test(direction.trim())
    ? Number(direction) : direction;
  const label = typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0 && numeric <= 360
    ? `${String(numeric || 360).padStart(3, '0')}°T`
    : typeof direction === 'string' && direction.trim().toUpperCase() === 'VRB'
    ? 'VRB' : 'Direction unavailable ·';
  return `${label} ${speed}${gust} kt`;
}
