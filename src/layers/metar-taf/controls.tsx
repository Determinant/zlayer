import { formatDataAge } from '../../core/format/time';
import type { MetarLoadState } from './metar/layer';
export function WeatherControls({ enabled: metarEnabled, status: metarStatus,
  observedAt: metarObservedAt, weatherAirportCount, onToggle: onMetarVisibilityChange }: {
  enabled: boolean; status: MetarLoadState['status'];
  observedAt: string | undefined; weatherAirportCount: number; onToggle(): void;
}) {
  return <div className="toggle-list">
    <button className={metarEnabled ? 'is-active' : ''} type="button" onClick={onMetarVisibilityChange}
      role="switch" aria-checked={metarEnabled}>
      <span className="weather-swatch" aria-hidden="true">
        <i className="is-vfr" /><i className="is-mvfr" /><i className="is-ifr" /><i className="is-lifr" />
      </span>
      <span className="layer-copy">
        <strong>METAR flight categories</strong>
        <small>{metarSummary(metarEnabled, metarStatus, weatherAirportCount, metarObservedAt)}</small>
      </span>
      <span className="switch" aria-hidden="true"><i /></span>
    </button>
  </div>;
}
function metarSummary(
  enabled: boolean,
  status: MetarLoadState['status'],
  count: number,
  observedAt: string | undefined,
): string {
  if (!enabled) return count > 0 ? `${count.toLocaleString()} cached · categories hidden` : 'Off';
  if (status === 'loading') return 'Loading observations…';
  if (status === 'error') return 'Live source unavailable';
  if (count === 0) return 'No reports for visible airports';
  return `${count.toLocaleString()} visible airports · ${status === 'stale' ? 'Cached · ' : ''}${formatDataAge(observedAt)}`;
}
