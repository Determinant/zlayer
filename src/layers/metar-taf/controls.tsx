import { routingCatalog, type CatalogReadSource } from '../../workspace/read-context';
import { formatDataAge } from '../../core/format/time';
import type { MetarLoadState } from './metar/layer';
export function WeatherControls({ catalog, enabled: metarEnabled, status: metarStatus,
  observedAt: metarObservedAt, weatherAirportCount, onToggle: onMetarVisibilityChange }: {
  catalog: CatalogReadSource; enabled: boolean; status: MetarLoadState['status'];
  observedAt: string | undefined; weatherAirportCount: number; onToggle(): void;
}) { return (
            <section className="layer-section weather-section">
              <div className="section-title">
                <h3>AWC weather</h3>
                <span>{metarEnabled ? weatherStatusLabel(metarStatus) : 'Off'}</span>
              </div>
              <div className="toggle-list">
                <button
                  className={metarEnabled ? 'is-active' : ''}
                  type="button"
                  onClick={onMetarVisibilityChange}
                  role="switch"
                  aria-checked={metarEnabled}
                >
                  <span className="weather-swatch" aria-hidden="true">
                    <i className="is-vfr" />
                    <i className="is-mvfr" />
                    <i className="is-ifr" />
                    <i className="is-lifr" />
                  </span>
                  <span className="layer-copy">
                    <strong>METAR flight categories</strong>
                    <small>{metarSummary(
                      metarEnabled,
                      metarStatus,
                      weatherAirportCount,
                      metarObservedAt,
                    )}</small>
                  </span>
                  <span className="switch" aria-hidden="true"><i /></span>
                </button>
              </div>
              {routingCatalog(catalog).weather.filter((product) => product.id !== 'awc.metar').map((product) => (
                <div className="planned-layer" key={product.id}>
                  <span>{product.title}</span>
                  <small>Coming next</small>
                </div>
              ))}
            </section>

);
}
function metarSummary(
  enabled: boolean,
  status: MetarLoadState['status'],
  count: number,
  observedAt: string | undefined,
): string {
  if (!enabled) return count > 0 ? `${count.toLocaleString()} cached · categories hidden` : 'Off';
  if (status === 'loading') return 'Loading AWC observations…';
  if (status === 'error') return 'Live source unavailable';
  if (count === 0) return 'No reports for visible airports';
  return `${count.toLocaleString()} visible airports · ${status === 'stale' ? 'Cached · ' : ''}${formatDataAge(observedAt)}`;
}

function weatherStatusLabel(status: MetarLoadState['status']): string {
  return status === 'current' ? 'Live' : status;
}
