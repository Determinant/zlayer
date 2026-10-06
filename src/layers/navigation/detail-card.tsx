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
import { AirportRunways } from './airport-runways';

const DETAIL_TABS = [{ value: 'info', label: 'Info' }, { value: 'plates', label: 'Plates' }, { value: 'notams', label: 'NOTAM' }] as const;

type DetailBody = (active: boolean) => ReactNode;
export type FeatureDetailCardProps = {
  feature: GeoPointFeature; revision: string; placement: PanelTab; onClose(): void;
  actions: ReactNode; identification: ReactNode | undefined; onIdentificationChange(open: boolean): void;
  info: DetailBody; elevation: DetailBody; plates: DetailBody | undefined;
  runways?: DetailBody | undefined;
  notams?: { header?: ReactNode; contentKey?: string; body: DetailBody } | undefined;
};
export function FeatureDetailCard({ feature, revision, placement, onClose, actions,
  identification, onIdentificationChange, info, elevation, plates, runways, notams }: FeatureDetailCardProps) {
  // Stowing preserves the selection, ID overlay, and mounted tab content.
  const panel = useEdgePanel('details');
  const tabsId = useId();
  const [tab, setTab] = usePluginState<'info' | 'plates' | 'notams'>(pluginStorage, `feature-tab:${featureKey(feature)}`, 'info',
    (value): value is 'info' | 'plates' | 'notams' => value === 'info' || value === 'plates' || value === 'notams');
  const ident = featureIdent(feature);
  const label = formatWaypointLabel(ident);
  const hasRunways = Array.isArray(feature.properties.runways);
  const hasPlates = plates !== undefined;
  const tabs = DETAIL_TABS.filter(t => t.value === 'info' || t.value === 'plates' && hasPlates || t.value === 'notams' && notams);
  const hasTabs = tabs.length > 1;
  const navaid = feature.properties.kind === 'navaid';
  const selectedTab = tabs.some(t => t.value === tab) ? tab : 'info';
  const activeTab = identification ? undefined : selectedTab;
  const detailRows = featureDetailRows(feature, false);
  const needsTerrainElevation = feature.properties.kind === 'coordinate' && !detailRows.some(row => row.label === 'Elevation');
  if (needsTerrainElevation) {
    detailRows.splice(1, 0, { label: 'Elevation', value: '' });
  }

  return (
    <DetailPanel panel={panel} label={`${label} details`} tab={placement}
      title={label} titleHint={label === ident ? undefined : ident} actions={actions}
      onClose={onClose} closeLabel="Close detail" wide={hasTabs && !navaid}
      className={`feature-details-panel${hasPlates ? ' has-plates' : ''}`}
      bodyClassName={`${hasPlates ? 'has-plates' : ''}${feature.properties.kind === 'coordinate' ? ' is-coordinate' : ''}`}
      icon={<><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></>}
      contentLabel={identification ? 'Feature identification' : selectedTab === 'info' ? 'Feature information' : selectedTab === 'plates' ? 'Airport plates'
        : navaid ? 'Navaid NOTAMs' : 'Airport NOTAMs'}
      contentKey={notams?.contentKey}
      header={<>
        <span className="eyebrow">{String(feature.properties.kind ?? 'FAA feature')}</span>
        <p>{featureSubtitle(feature)}</p>
        {feature.properties.kind !== 'coordinate' &&
          <p className="feature-edition">FAA {formatDate(String(feature.properties.dataRevision ?? revision))}</p>}
        {hasTabs && <TabList id={tabsId} size="slim" label={navaid ? 'Navaid detail' : 'Airport detail'} tabs={tabs} value={activeTab}
          onChange={next => { onIdentificationChange(false); setTab(next); }} className="feature-tabs" />}
        {activeTab === 'notams' && notams?.header && <div className="feature-tabs">{notams.header}</div>}
      </>}>
      {identification && <div key="id" className="content-reveal">{identification}</div>}
      <div {...(hasTabs ? tabPanelProps(tabsId, 'info', activeTab) : { hidden: !!identification })}>
        {activeTab === 'info' && <div className="content-reveal">
          {detailRows.length > 0 && <dl className="feature-facts">
            {detailRows.map(({ label, value, wide, morse, frequency }) => (
              <div key={label} className={frequency ? 'is-wide is-frequency' : wide ? 'is-wide' : undefined}>
                <dt title={label === 'CD' ? 'Clearance delivery' : label === 'App / Dep' ? 'Approach / Departure' : undefined}>{label}</dt>
                <dd>{needsTerrainElevation && label === 'Elevation' ? elevation(panel.open)
                  : frequency ? <AirportFrequencyValue label={label} frequency={frequency} /> : <>
                  {value}{morse && <span className="navaid-morse" role="img"
                  aria-label={morse.description} title={`Morse identifier ${morse.identifier}`}>
                  {morse.groups.map((code, index) => <span key={index} aria-hidden="true">{code}{' '}</span>)}
                </span>}</>}</dd>
              </div>
            ))}
          </dl>}
          {info(panel.open)}
          {hasRunways && (runways ? runways(panel.open) : <AirportRunways feature={feature} />)}
        </div>}
      </div>
      {hasPlates && <div {...tabPanelProps(tabsId, 'plates', activeTab)}>
        {activeTab === 'plates' && <div className="content-reveal">{plates(panel.open)}</div>}
      </div>}
      {notams && <div {...tabPanelProps(tabsId, 'notams', activeTab)}>
        {activeTab === 'notams' && <div className="content-reveal">{notams.body(panel.open)}</div>}
      </div>}
    </DetailPanel>
  );
}
