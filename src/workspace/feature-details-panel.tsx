import { EdgePanelFrame, useEdgePanel } from '../core/ui/edge-panels';
import { usePersistentState } from '../core/ui/use-persistent-state';
import { formatDate } from '../core/format/time';
import type { SavedSupplement } from './read-context';

import type { GeoPointFeature, ProcedureResourceRecord } from '@zlayer/contracts';
import { featureIdent, featureKey, featureSubtitle, type NearbyVor } from '@zlayer/domain';

import { AirportPlates, type ProcedureSelection } from '../layers/plates';
import { hasAirportPlates } from '../layers/plates/data';
import { featureDetailRows } from '../layers/navigation/feature-details';
import { AirportFrequencyValue } from '../layers/navigation/airport-frequency-value';
import { AirportRunways } from '../layers/navigation/airport-runways';
import { NearbyNavaids } from '../layers/navigation/nearby-navaids';
import { AirportWeather, type MetarClient } from '../layers/metar-taf';
import { FeatureRouteActions, type FeatureRoute } from './feature-route-actions';

type FeatureDetailsPanelProps = {
  feature: GeoPointFeature;
  metarClient: MetarClient;
  procedureResource: ProcedureResourceRecord | undefined;
  revision: string;
  savedSupplement?: SavedSupplement | undefined;
  editionUnavailable?: boolean;
  identification?: { stations: readonly NearbyVor[] | undefined; loading: boolean } | undefined;
  onIdentificationChange: (open: boolean) => void;
  route: FeatureRoute;
  onClose: () => void;
  onOpenProcedure: (selection: ProcedureSelection) => void;
};

export function FeatureDetailsPanel({
  feature,
  metarClient,
  procedureResource,
  revision,
  savedSupplement,
  editionUnavailable = false,
  identification,
  onIdentificationChange,
  route,
  onClose,
  onOpenProcedure,
}: FeatureDetailsPanelProps) {
  // Stowing preserves the selection, ID overlay, and mounted tab content.
  const panel = useEdgePanel('details');
  const [tab, setTab] = usePersistentState<'info' | 'plates'>(`feature-tab:${featureKey(feature)}`, 'info',
    (value): value is 'info' | 'plates' => value === 'info' || value === 'plates');
  const ident = featureIdent(feature);
  const coordinateLabel = feature.properties.kind === 'coordinate' && /^(\d{6}[NS])(\d{7}[EW])$/.exec(ident);
  const hasRunways = Array.isArray(feature.properties.runways);
  const hasPlates = hasAirportPlates(feature);
  const detailRows = featureDetailRows(feature, false);

  return (
    <EdgePanelFrame panel={panel} label={`${ident} details`} tab={{ edge: 'bottom', order: 1 }}
      className={`feature-details-panel${hasPlates ? ' has-plates' : ''}`}
      icon={<><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></>}>
      <article {...panel.bodyProps}
        className={`feature-card edge-panel-body${hasPlates ? ' has-plates' : ''}${feature.properties.kind === 'coordinate' ? ' is-coordinate' : ''}`}>
        <button className="close-card" type="button" onClick={() => panel.close(onClose)} aria-label="Close detail">
          ×
        </button>
        <div className="feature-card-heading">
          <h2>{coordinateLabel ? <>{coordinateLabel[1]}<wbr />{coordinateLabel[2]}</> : ident}</h2>
          <div className="feature-card-actions">
            <FeatureRouteActions feature={feature} route={route} />
            <button className="identify-feature-button" type="button" aria-pressed={!!identification}
              aria-label={`Identify ${ident} with nearby navaids`} title="Identify using nearby navaids"
              onClick={() => onIdentificationChange(!identification)}>ID</button>
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
                className={!identification && tab === 'info' ? 'is-active' : undefined}
                type="button"
                onClick={() => { onIdentificationChange(false); setTab('info'); }}
              >
                Info
              </button>
              <button
                className={!identification && tab === 'plates' ? 'is-active' : undefined}
                type="button"
                onClick={() => { onIdentificationChange(false); setTab('plates'); }}
              >
                Plates
              </button>
            </nav>
          )}
        </div>
        <div className="feature-card-content panel-scroll" role="region" tabIndex={0}
          aria-label={identification ? 'Feature identification' : tab === 'info' ? 'Feature information' : 'Airport plates'}>
          <div key={identification ? 'id' : tab} className="content-reveal">
            {identification ? <NearbyNavaids {...identification} /> : tab === 'info' ? (
              <>
                {detailRows.length > 0 && <dl className="feature-facts">
                  {detailRows.map(({ label, value, wide, morse, notes, frequency }) => (
                    <div key={label} className={frequency ? 'is-wide is-frequency' : wide ? 'is-wide' : undefined}>
                      <dt>{label}</dt>
                      <dd>{frequency ? <AirportFrequencyValue {...{ label, value, ...(notes ? { notes } : {}) }} /> : <>
                        {value}{morse && <span className="navaid-morse" role="img"
                        aria-label={morse.description} title={`Morse identifier ${morse.identifier}`}>
                        {morse.groups.map((code, index) => <span key={index} aria-hidden="true">{code}{' '}</span>)}
                      </span>}</>}</dd>
                    </div>
                  ))}
                </dl>}
                <AirportWeather feature={feature} client={metarClient} />
                {hasRunways && <AirportRunways feature={feature} />}
              </>
            ) : editionUnavailable ? (
              <p className="procedure-state is-error">This feature’s source edition is unavailable. Select it again after its navigation data reloads.</p>
            ) : (
              <AirportPlates
                feature={feature}
                resource={procedureResource}
                revision={revision}
                savedSupplement={savedSupplement}
                onOpen={onOpenProcedure}
              />
            )}
          </div>
        </div>
      </article>
    </EdgePanelFrame>
  );
}
