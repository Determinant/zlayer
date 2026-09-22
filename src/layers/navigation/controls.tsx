import { Fragment, useId, type CSSProperties } from 'react';
import type { NavigationData, NavigationLayerId } from '@zlayer/contracts';
import { routingCatalog, type CatalogReadSource } from '../../workspace/read-context';
import { NAVIGATION_LAYERS, type LayerVisibility, type NavigationLoadState } from './index';
import type { FixDisplaySettings } from './fix-display';
import { FixDisplayControls } from './fix-display-controls';
export type NavigationControlsInput = {
  catalog: CatalogReadSource; visibility: LayerVisibility; fixDisplay: FixDisplaySettings;
  navigationData: NavigationData; loadState: NavigationLoadState;
  onFixDisplayChange(settings: FixDisplaySettings): void; onVisibilityChange(id: NavigationLayerId): void;
};
export function NavigationControls({ catalog, visibility, fixDisplay, navigationData, loadState,
  onFixDisplayChange, onVisibilityChange }: NavigationControlsInput) {
  const fixDetailsId = useId();
  return (
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

);
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
