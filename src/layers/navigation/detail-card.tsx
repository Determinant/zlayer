import { pluginStorage } from './storage';
import type { ReactNode } from 'react';
import { EdgePanelFrame, useEdgePanel, type PanelTab } from '../../core/ui/edge-panels';
import { usePluginState } from '../../core/ui/use-persistent-state';
import { formatDate } from '../../core/format/time';
import { formatWaypointLabel } from '../../core/format/coordinates';
import type { GeoPointFeature } from '@zlayer/contracts';
import { featureIdent, featureKey, featureSubtitle } from '@zlayer/domain';
import { featureDetailRows } from './feature-details';
import { AirportFrequencyValue } from './airport-frequency-value';
import { AirportRunways, type RunwayWeather } from './airport-runways';

type DetailBody = (active: boolean) => ReactNode;
export type FeatureDetailCardProps = {
  feature: GeoPointFeature; revision: string; placement: PanelTab; onClose(): void;
  actions: ReactNode; identification: ReactNode | undefined; onIdentificationChange(open: boolean): void;
  info: DetailBody; elevation: DetailBody; plates: DetailBody | undefined;
  runwayWeather?: RunwayWeather | undefined;
};
export function FeatureDetailCard({ feature, revision, placement, onClose, actions,
  identification, onIdentificationChange, info, elevation, plates, runwayWeather }: FeatureDetailCardProps) {
  // Stowing preserves the selection, ID overlay, and mounted tab content.
  const panel = useEdgePanel('details');
  const [tab, setTab] = usePluginState<'info' | 'plates'>(pluginStorage, `feature-tab:${featureKey(feature)}`, 'info',
    (value): value is 'info' | 'plates' => value === 'info' || value === 'plates');
  const ident = featureIdent(feature);
  const label = formatWaypointLabel(ident);
  const hasRunways = Array.isArray(feature.properties.runways);
  const hasPlates = plates !== undefined;
  const selectedTab = hasPlates ? tab : 'info';
  const detailRows = featureDetailRows(feature, false);
  const needsTerrainElevation = feature.properties.kind === 'coordinate' && !detailRows.some(row => row.label === 'Elevation');
  if (needsTerrainElevation) {
    detailRows.splice(1, 0, { label: 'Elevation', value: '' });
  }

  return (
    <EdgePanelFrame panel={panel} label={`${label} details`} tab={placement}
      className={`feature-details-panel${hasPlates ? ' has-plates' : ''}`}
      icon={<><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></>}>
      <article {...panel.bodyProps}
        className={`feature-card edge-panel-body${hasPlates ? ' has-plates' : ''}${feature.properties.kind === 'coordinate' ? ' is-coordinate' : ''}`}>
        <button className="close-card" type="button" onClick={() => panel.close(onClose)} aria-label="Close detail">
          ×
        </button>
        <div className="feature-card-heading">
          <h2 title={label === ident ? undefined : ident}>{label}</h2>
          <div className="feature-card-actions">
            {actions}
          </div>
        </div>
        <div className="feature-card-header">
          <span className="eyebrow">{String(feature.properties.kind ?? 'FAA feature')}</span>
          <p>{featureSubtitle(feature)}</p>
          {feature.properties.kind !== 'coordinate' &&
            <p className="feature-edition">FAA {formatDate(String(feature.properties.dataRevision ?? revision))}</p>}
          {hasPlates && (
            <nav className="feature-tabs" aria-label="Airport detail">
              <button
                className={!identification && selectedTab === 'info' ? 'is-active' : undefined}
                type="button"
                onClick={() => { onIdentificationChange(false); setTab('info'); }}
              >
                Info
              </button>
              <button
                className={!identification && selectedTab === 'plates' ? 'is-active' : undefined}
                type="button"
                onClick={() => { onIdentificationChange(false); setTab('plates'); }}
              >
                Plates
              </button>
            </nav>
          )}
        </div>
        <div className="feature-card-content panel-scroll" role="region" tabIndex={0}
          aria-label={identification ? 'Feature identification' : selectedTab === 'info' ? 'Feature information' : 'Airport plates'}>
          <div key={identification ? 'id' : selectedTab} className="content-reveal">
            {identification ? identification : selectedTab === 'info' ? (
              <>
                {detailRows.length > 0 && <dl className="feature-facts">
                  {detailRows.map(({ label, value, wide, morse, notes, frequency }) => (
                    <div key={label} className={frequency ? 'is-wide is-frequency' : wide ? 'is-wide' : undefined}>
                      <dt>{label}</dt>
                      <dd>{needsTerrainElevation && label === 'Elevation' ? elevation(panel.open)
                        : frequency ? <AirportFrequencyValue {...{ label, value, ...(notes ? { notes } : {}) }} /> : <>
                        {value}{morse && <span className="navaid-morse" role="img"
                        aria-label={morse.description} title={`Morse identifier ${morse.identifier}`}>
                        {morse.groups.map((code, index) => <span key={index} aria-hidden="true">{code}{' '}</span>)}
                      </span>}</>}</dd>
                    </div>
                  ))}
                </dl>}
                {info(panel.open)}
                {hasRunways && <AirportRunways feature={feature} weather={runwayWeather} />}
              </>
            ) : plates?.(panel.open)}
          </div>
        </div>
      </article>
    </EdgePanelFrame>
  );
}
