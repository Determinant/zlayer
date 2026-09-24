import { pluginStorage } from './storage';
import { useId, type ReactNode } from 'react';
import { TabList, tabPanelProps } from '../../core/ui/tabs';
import { useEdgePanel, type PanelTab } from '../../core/ui/edge-panels';
import { DetailPanel } from '../../core/ui/detail-panel';
import { usePluginState } from '../../core/ui/use-persistent-state';
import { formatDate } from '../../core/format/time';
import { formatWaypointLabel } from '../../core/format/coordinates';
import type { GeoPointFeature } from '@zlayer/contracts';
import { featureIdent, featureKey, featureSubtitle } from '@zlayer/domain';
import { featureDetailRows } from './feature-details';
import { AirportFrequencyValue } from './airport-frequency-value';
import { AirportRunways, type RunwayWeather } from './airport-runways';

const DETAIL_TABS = [{ value: 'info', label: 'Info' }, { value: 'plates', label: 'Plates' }] as const;

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
  const tabsId = useId();
  const [tab, setTab] = usePluginState<'info' | 'plates'>(pluginStorage, `feature-tab:${featureKey(feature)}`, 'info',
    (value): value is 'info' | 'plates' => value === 'info' || value === 'plates');
  const ident = featureIdent(feature);
  const label = formatWaypointLabel(ident);
  const hasRunways = Array.isArray(feature.properties.runways);
  const hasPlates = plates !== undefined;
  const selectedTab = hasPlates ? tab : 'info';
  const activeTab = identification ? undefined : selectedTab;
  const detailRows = featureDetailRows(feature, false);
  const needsTerrainElevation = feature.properties.kind === 'coordinate' && !detailRows.some(row => row.label === 'Elevation');
  if (needsTerrainElevation) {
    detailRows.splice(1, 0, { label: 'Elevation', value: '' });
  }

  return (
    <DetailPanel panel={panel} label={`${label} details`} tab={placement}
      title={label} titleHint={label === ident ? undefined : ident} actions={actions}
      onClose={onClose} closeLabel="Close detail" wide={hasPlates}
      className={`feature-details-panel${hasPlates ? ' has-plates' : ''}`}
      bodyClassName={`${hasPlates ? 'has-plates' : ''}${feature.properties.kind === 'coordinate' ? ' is-coordinate' : ''}`}
      icon={<><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></>}
      contentLabel={identification ? 'Feature identification' : selectedTab === 'info' ? 'Feature information' : 'Airport plates'}
      header={<>
        <span className="eyebrow">{String(feature.properties.kind ?? 'FAA feature')}</span>
        <p>{featureSubtitle(feature)}</p>
        {feature.properties.kind !== 'coordinate' &&
          <p className="feature-edition">FAA {formatDate(String(feature.properties.dataRevision ?? revision))}</p>}
        {hasPlates && <TabList id={tabsId} label="Airport detail" tabs={DETAIL_TABS} value={activeTab}
          onChange={next => { onIdentificationChange(false); setTab(next); }} className="feature-tabs" />}
      </>}>
      {identification && <div key="id" className="content-reveal">{identification}</div>}
      <div {...(hasPlates ? tabPanelProps(tabsId, 'info', activeTab) : { hidden: !!identification })}>
        {activeTab === 'info' && <div className="content-reveal">
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
        </div>}
      </div>
      {hasPlates && <div {...tabPanelProps(tabsId, 'plates', activeTab)}>
        {activeTab === 'plates' && <div className="content-reveal">{plates(panel.open)}</div>}
      </div>}
    </DetailPanel>
  );
}
