import { routingCatalog, type CatalogReadSource } from '../workspace/read-context';
import { formatDate, formatDataAge } from '../core/format/time';
import { Fragment, useEffect, useId, useRef, type CSSProperties } from 'react';
import { usePersistentState } from '../core/ui/use-persistent-state';
import { useBackDismiss } from '../core/ui/pwa-back';
import { isBoolean } from '../core/storage/ui-state';

import type {
  NavigationData,
  NavigationLayerId,
} from '@zlayer/contracts';

import {
  chartCountForSelection, chartSelectionTitle,
  type ChartBaseSelection, type ChartOverlaySelection, type ChartSelection,
} from '../layers/charts';
import type { MetarLoadState } from '../layers/metar-taf';
import { NAVIGATION_LAYERS, type LayerVisibility, type NavigationLoadState } from '../layers/navigation';
import type { FixDisplaySettings } from '../layers/navigation/fix-display';
import { FixDisplayControls } from '../layers/navigation/fix-display-controls';
import { ChartControls } from './chart-controls';
import { TerrainControls, type TerrainCoverage, type TerrainStatus } from '../layers/terrain';
import { ObstructionControls, type ObstructionStatus } from '../layers/obstructions';

type LayerMenuProps = {
  catalog: CatalogReadSource;
  chartSelection: ChartSelection;
  visibility: LayerVisibility;
  fixDisplay: FixDisplaySettings;
  onFixDisplayChange: (settings: FixDisplaySettings) => void;
  navigationData: NavigationData;
  loadState: NavigationLoadState;
  visibleFeatureCount: number;
  metarEnabled: boolean;
  metarStatus: MetarLoadState['status'];
  metarObservedAt: string | undefined;
  weatherAirportCount: number;
  onChartBaseChange: (base: ChartBaseSelection) => void;
  onChartOverlayChange: (overlay: ChartOverlaySelection) => void;
  onVisibilityChange: (layerId: NavigationLayerId) => void;
  onMetarVisibilityChange: () => void;
  terrainEnabled: boolean;
  terrainCoverage: TerrainCoverage;
  onTerrainCoverageChange: (coverage: TerrainCoverage) => void;
  terrainStatus: TerrainStatus;
  onTerrainVisibilityChange: () => void;
  obstructionsEnabled: boolean;
  obstructionStatus: ObstructionStatus;
  onObstructionVisibilityChange: () => void;
};

export function LayerMenu({
  catalog,
  chartSelection,
  visibility,
  fixDisplay,
  onFixDisplayChange,
  navigationData,
  loadState,
  visibleFeatureCount,
  metarEnabled,
  metarStatus,
  metarObservedAt,
  weatherAirportCount,
  onChartBaseChange,
  onChartOverlayChange,
  onVisibilityChange,
  onMetarVisibilityChange,
  terrainEnabled,
  terrainCoverage,
  onTerrainCoverageChange,
  terrainStatus,
  onTerrainVisibilityChange,
  obstructionsEnabled,
  obstructionStatus,
  onObstructionVisibilityChange,
}: LayerMenuProps) {
  const [open, setOpen] = usePersistentState('layers-open', false, isBoolean);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useBackDismiss(open, menuRef, () => { setOpen(false); buttonRef.current?.focus(); });
  const popoverId = useId();
  const fixDetailsId = `${popoverId}-fix-details`;
  const activeChartCount = chartCountForSelection(catalog.charts, chartSelection);
  const activeCount = Object.values(visibility).filter(Boolean).length +
    (chartSelection.base ? 1 : 0) + (chartSelection.overlay ? 1 : 0) +
    (metarEnabled ? 1 : 0) + (terrainEnabled ? 1 : 0) + (obstructionsEnabled ? 1 : 0);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="layer-menu" ref={menuRef}>
      <button
        ref={buttonRef}
        className={`layer-control-button ${open ? 'is-open' : ''}`}
        type="button"
        aria-label={open ? 'Close map layers' : 'Open map layers'}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 3 8 4-8 4-8-4 8-4Z" />
          <path d="m4 11 8 4 8-4" />
          <path d="m4 15 8 4 8-4" />
        </svg>
        <span className="active-layer-count">{activeCount}</span>
      </button>

      {open && (
        <aside
          className="layer-popover"
          id={popoverId}
          role="dialog"
          aria-label="Map layers"
        >
          <div className="layer-popover-content panel-scroll">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Map display</span>
                <h2>Layers</h2>
              </div>
              <span className="feature-count">
                {visibleFeatureCount.toLocaleString()} loaded
              </span>
            </div>

            <ChartControls charts={catalog.charts} selection={chartSelection}
              onBaseChange={onChartBaseChange} onOverlayChange={onChartOverlayChange} />
            <TerrainControls enabled={terrainEnabled} status={terrainStatus} onToggle={onTerrainVisibilityChange}
              coverage={terrainCoverage} onCoverageChange={onTerrainCoverageChange} />
            <ObstructionControls enabled={obstructionsEnabled} status={obstructionStatus} onToggle={onObstructionVisibilityChange} />

            <section className="layer-section">
              <div className="section-title">
                <h3>FAA reference</h3>
                <span>Selectable</span>
              </div>
              <div className="toggle-list">
                {NAVIGATION_LAYERS.map((layer) => {
                  const catalogLayer = routingCatalog(catalog).navigation.find((item) => item.id === layer.id);
                  return (
                    <Fragment key={layer.id}>
                      <button
                        className={visibility[layer.id] ? 'is-active' : ''}
                        type="button"
                        onClick={() => onVisibilityChange(layer.id)}
                        role="switch"
                        aria-checked={visibility[layer.id]}
                        aria-controls={layer.id === 'fixes' && visibility.fixes ? fixDetailsId : undefined}
                      >
                        <span
                          className="layer-swatch"
                          style={{ '--swatch': layer.color } as CSSProperties}
                        >
                          {layer.shortTitle}
                        </span>
                        <span className="layer-copy">
                          <strong>{layer.title}</strong>
                          <small>{navigationLayerSummary(
                            loadState[layer.id],
                            navigationData[layer.id]?.features.length,
                            catalogLayer?.sourceCount ?? 0,
                          )}</small>
                        </span>
                        <span className="switch" aria-hidden="true"><i /></span>
                      </button>
                      {layer.id === 'fixes' && visibility.fixes && (
                        <div id={fixDetailsId} className="fix-display-options content-reveal">
                          <FixDisplayControls value={fixDisplay} onChange={onFixDisplayChange} />
                        </div>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            </section>

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

            <footer className="panel-footer">
              <span>Chart stack</span>
              <strong>{chartSelectionTitle(chartSelection)}</strong>
              <small>
                {chartSelection.base
                  ? `Cycle ${formatDate(routingCatalog(catalog).revision)} · ${activeChartCount} files · cached as viewed`
                  : 'Continuous basemap'}
              </small>
            </footer>
          </div>
        </aside>
      )}
    </div>
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

function navigationLayerSummary(
  status: NavigationLoadState[NavigationLayerId],
  loadedCount: number | undefined,
  sourceCount: number,
): string {
  if (status === 'loading') return 'Loading package…';
  if (status === 'error') return 'Package unavailable';
  if (status === 'partial') return `${(loadedCount ?? 0).toLocaleString()} in coverage · Partial data`;
  if (status === 'ready') return `${(loadedCount ?? 0).toLocaleString()} in coverage`;
  return `${sourceCount.toLocaleString()} source records`;
}

function weatherStatusLabel(status: MetarLoadState['status']): string {
  return status === 'current' ? 'Live' : status;
}
