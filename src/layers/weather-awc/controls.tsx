import type { AwcAdvisoryProduct } from '@zlayer/contracts';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { formatTimestamp, formatTimestampRange, formatAge } from '../../core/format/time';
import { useEdgePanel } from '../../core/ui/edge-panels';
import { DetailPanel } from '../../core/ui/detail-panel';
import { ToolPanel } from '../../core/ui/tool-panel';
import { TabList, tabPanelProps } from '../../core/ui/tabs';
import type { AdvisoryState } from './client';
import type { WeatherController, WeatherState } from './controller';
import type { WeatherAwcPreferences } from './preferences';
import { advisoryTitle, advisoryHazard } from './source';
import { advisoryFrame } from './time';
import { ADVISORY_LEGEND } from './palette';
import { GridControls, GridPointDetails } from './grids/controls';
import { WeatherTimeline } from './timeline';
import { RadarControls } from './radar/controls';
import { ProgsControls, SurfaceDetails } from './progs/controls';
import './styles.css';

type BooleanKey = { [K in keyof WeatherAwcPreferences]: WeatherAwcPreferences[K] extends boolean ? K : never }[keyof WeatherAwcPreferences];
const FILTERS: readonly [BooleanKey, string][] = [
  ['awcGairmet', 'G-AIRMET'], ['awcSigmet', 'SIGMET'], ['awcConvective', 'Convective SIGMET'],
  ['awcCwa', 'CWA'], ['awcFreezing', 'Freezing contours'],
];
const HAZARD_FILTERS: readonly [BooleanKey, string][] = [
  ['awcIcing', 'Icing'], ['awcTurbulence', 'Turbulence'], ['awcIfr', 'IFR'],
  ['awcMountain', 'Mountain obscuration'], ['awcWind', 'Surface wind / wind shear'],
];

export function WeatherControls({ controller }: { controller: WeatherController }) {
  const state = useLayerSnapshot(controller), p = state.preferences;
  return <div className="toggle-list"><button type="button" role="switch" aria-checked={p.awcEnabled}
      className={p.awcEnabled ? 'is-active' : ''} onClick={() => controller.change({ awcEnabled: !p.awcEnabled })}>
      <span className="layer-swatch awc-swatch" aria-hidden="true">WX</span>
      <span className="layer-copy"><strong>Forecasts &amp; advisories</strong><small>CONUS · Radar · Progs · Clouds · Icing · Winds · Advisories</small></span>
      <span className="switch" aria-hidden="true"><i /></span>
    </button></div>;
}

function WeatherFilters({ controller }: { controller: WeatherController }) {
  const { preferences: p } = useLayerSnapshot(controller);
  return <div className="awc-filters">
    <h4>Products</h4>
    <div className="awc-filter-grid" role="group" aria-label="Advisory products">
      {FILTERS.map(([key, label]) => <label key={key} className={`awc-filter${key === 'awcFreezing' ? ' awc-filter--wide' : ''}`}>
        <input type="checkbox" checked={p[key]} onChange={e => controller.change({ [key]: e.currentTarget.checked })} />
        <span>{label}</span>
      </label>)}
    </div>
    {p.awcGairmet && <details className="awc-hazards"><summary>G-AIRMET hazards</summary>
      <div className="awc-filter-grid" role="group" aria-label="G-AIRMET hazards">
        {HAZARD_FILTERS.map(([key, label]) => <label key={key} className={`awc-filter${key === 'awcWind' ? ' awc-filter--wide' : ''}`}>
          <input type="checkbox" checked={p[key]} onChange={e => controller.change({ [key]: e.currentTarget.checked })} />
          <span>{label}</span>
        </label>)}
      </div>
    </details>}
  </div>;
}

function sourceStatus(record: AdvisoryState, now: number) {
  const age = record.snapshot ? now - record.snapshot.checkedAt : undefined;
  const stale = !record.checkedAt || age === undefined || age < 0 || age > 10 * 60_000 || !!record.error;
  const label = record.loading ? 'Refreshing…' : record.error ? 'Refresh failed' : !record.snapshot ? 'Not checked' : stale ? 'Cached / unverified' : 'Checked';
  return { age, stale, label };
}

function ProductStatus({ state, product, shown }: { state: WeatherState; product: AwcAdvisoryProduct; shown: number }) {
  const record = state.products[product];
  const selected = state.selectedTime ?? state.now;
  const frame = advisoryFrame(record.snapshot, selected);
  const { age, stale, label: status } = sourceStatus(record, state.now);
  const label = product === 'gairmet' ? 'G-AIRMET' : product === 'sigmet' ? 'SIGMET' : 'CWA';
  return <div className="awc-product-status" data-product={product}>
    <strong>{label}</strong><span>{status}
      {age !== undefined && ` · ${formatAge(age)} ago`}</span>
    <small>{state.advisoryDisplay.error ? 'Advisory display unavailable' : state.advisoryDisplay.loading ? 'Rendering advisories…'
      : !record.snapshot ? 'Data unavailable' : frame.time === undefined ? 'No forecast available for this time'
      : product === 'gairmet' ? `${shown} shown · Snapshot ${formatTimestamp(frame.time)}`
        : frame.advisories.length ? `${shown} shown · ${frame.advisories.length} applicable advisories`
          : selected > state.now ? 'No issued advisories cover this time' : stale ? 'No active advisories in saved data' : 'No active advisories'}</small>
    {record.error && <small className="awc-error">{record.error}</small>}
  </div>;
}

function AdvisoryControls({ controller }: { controller: WeatherController }) {
  const state = useLayerSnapshot(controller), p = state.preferences;
  const gairmetTime = advisoryFrame(state.products.gairmet.snapshot, state.selectedTime ?? state.now).time;
  const advisories = controller.visibleAdvisories();
  const counts = useMemo(() => {
    const displayed = new Set(state.advisoryDisplay.ids), counts = { gairmet: 0, sigmet: 0, cwa: 0 };
    for (const advisory of advisories) if (displayed.has(advisory.id)) counts[advisory.product]++;
    return counts;
  }, [advisories, state.advisoryDisplay.ids]);
  const degraded = Object.entries(state.products).some(([product, record]) => {
    const enabled = product === 'gairmet' ? p.awcGairmet || p.awcFreezing : product === 'sigmet' ? p.awcSigmet || p.awcConvective : p.awcCwa;
    return enabled && sourceStatus(record, state.now).stale;
  });
  return <>
    {(p.awcGairmet || p.awcFreezing) && <small className="awc-frame-time">
      G-AIRMET: {gairmetTime === undefined ? 'No forecast for this time' : formatTimestamp(gairmetTime)}</small>}
    <WeatherFilters controller={controller} />
    {state.advisoryDisplay.error && <div className="awc-error" role="status">
      <span>{state.advisoryDisplay.error}</span>{' '}
      <button type="button" className="ui-button ui-button--slim" onClick={() => controller.retryAdvisories()}>Retry advisories</button>
    </div>}
    <small>Right-click or long-press an advisory, then choose Inspect weather.</small>
    <details className="awc-source-status"><summary>{degraded ? 'Cached / unavailable · ' : ''}Products &amp; source status</summary>
      {(p.awcGairmet || p.awcFreezing) && <ProductStatus state={state} product="gairmet" shown={counts.gairmet} />}
      {(p.awcSigmet || p.awcConvective) && <ProductStatus state={state} product="sigmet" shown={counts.sigmet} />}
      {p.awcCwa && <ProductStatus state={state} product="cwa" shown={counts.cwa} />}
      <p>Forecast snapshots show their own valid time.</p>
      <div className="awc-legend">{ADVISORY_LEGEND.map(({ color, label }) =>
        <span key={label}><i style={{ backgroundColor: color }} aria-hidden="true" />{label}</span>)}</div>
      <a href="https://aviationweather.gov/gfa/" target="_blank" rel="noreferrer">NOAA / Aviation Weather Center</a>
    </details>
  </>;
}

const WEATHER_TABS = [{ value: 'advisories', label: 'Advis.', accessibleLabel: 'Advisories' }, { value: 'progs', label: 'Progs' }, { value: 'radar', label: 'Radar' },
  { value: 'clouds', label: 'Cloud' }, { value: 'icing', label: 'Icing' }, { value: 'winds', label: 'Winds' }] as const;
type WeatherCategory = (typeof WEATHER_TABS)[number]['value'];

export function WeatherToolbox({ controller }: { controller: WeatherController }) {
  return <ToolPanel className="map-edge-awc" icon={<><path d="M6 16a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 1 9" /><path d="m11 13-3 5h5l-2 4" /></>}>
    {(_visible, panel) => <WeatherToolboxContent controller={controller} panel={panel} />}
  </ToolPanel>;
}

function WeatherToolboxContent({ controller, panel }: { controller: WeatherController; panel: ReturnType<typeof useEdgePanel> }) {
  const state = useLayerSnapshot(controller), p = state.preferences;
  const tabsId = useId();
  const [category, setCategory] = useState<WeatherCategory>('advisories');
  const content = useRef<HTMLElement>(null);
  const [focusAltitude, setFocusAltitude] = useState(false);
  const active = { advisories: p.awcGairmet || p.awcSigmet || p.awcConvective || p.awcCwa || p.awcFreezing,
    progs: p.awcProgs, radar: p.awcRadar, clouds: p.awcGridMode.startsWith('cloud'),
    icing: p.awcGridMode.startsWith('icing') || p.awcGridMode.startsWith('freezing') || p.awcGridMode === 'sldPotential',
    winds: p.awcWindBarbs || p.awcGridMode === 'temperature' };
  useLayoutEffect(() => controller.altitudeControls.subscribe(category => {
    panel.setOpen(true, () => { setCategory(category); setFocusAltitude(true); });
  }), [controller, panel.setOpen]);
  useLayoutEffect(() => {
    if (!panel.open || !focusAltitude) return;
    const slider = content.current?.querySelector<HTMLInputElement>('[role="tabpanel"]:not([hidden]) .awc-altitude input');
    const target = slider && !slider.disabled ? slider
      : content.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    target?.focus();
    setFocusAltitude(false);
  }, [panel.open, focusAltitude, category]);
  return <section ref={content} className="awc-toolbox" aria-label="AWC Weather toolbox">
      <div className="awc-toolbox-heading"><h3>AWC Weather</h3><span>{category === 'progs' ? 'N. America' : 'CONUS'}</span>
        <button className="ui-switch" type="button" role="switch" aria-label="Show AWC weather"
          aria-checked={p.awcEnabled} onClick={() => controller.change({ awcEnabled: !p.awcEnabled })}>
          <span className="switch" aria-hidden="true"><i /></span>
        </button>
      </div>
      {!p.awcEnabled ? <p>Turn on AWC weather to view forecasts and choose products.</p> : <>
        <WeatherTimeline controller={controller} />
        <TabList id={tabsId} size="slim" className="awc-product-tabs" label="AWC weather products"
          tabs={WEATHER_TABS.map(tab => ({ ...tab, active: active[tab.value], description: active[tab.value] ? 'Map overlay enabled' : 'Map overlay off' }))}
          value={category} onChange={setCategory} />
        <div className="awc-tab-content panel-scroll" tabIndex={0} {...tabPanelProps(tabsId, 'advisories', category)}>
          {category === 'advisories' && <AdvisoryControls controller={controller} />}
        </div>
        <div className="awc-tab-content panel-scroll" tabIndex={0} {...tabPanelProps(tabsId, 'progs', category)}>
          {category === 'progs' && <ProgsControls controller={controller} />}
        </div>
        <div className="awc-tab-content panel-scroll" tabIndex={0} {...tabPanelProps(tabsId, 'radar', category)}>
          {category === 'radar' && <RadarControls controller={controller} />}
        </div>
        {(['clouds', 'icing', 'winds'] as const).map(tab => <div key={tab} className="awc-tab-content panel-scroll" tabIndex={0} {...tabPanelProps(tabsId, tab, category)}>
          {category === tab && <GridControls controller={controller} category={tab} />}
        </div>)}
      </>}
    </section>;
}

export function WeatherDetails({ controller, revision }: { controller: WeatherController; revision?: string | undefined }) {
  const state = useLayerSnapshot(controller);
  const panel = useEdgePanel('weather-awc-details');
  // Each explicit inspection requests the panel again, including the same point/advisory
  // after stowing or opening navigation details. Source refreshes do not.
  useLayoutEffect(() => {
    if (state.selectedIds.length || state.gridPoint) panel.setOpen(true);
  }, [state.selectedIds, state.gridPoint, panel.setOpen]);
  if (!state.selectedIds.length && !state.gridPoint) return null;
  const ids = new Set(state.selectedIds);
  const advisories = ids.size ? Object.values(state.products).flatMap(p => p.snapshot?.advisories ?? []).filter(a => ids.has(a.id)) : [];
  const surface = ids.size ? controller.surfaceSelection().frame?.features.filter(f => ids.has(f.id)) ?? [] : [];
  if (!advisories.length && !surface.length && !state.gridPoint) return null;
  return <DetailPanel panel={panel} title={state.gridPoint || surface.length ? "Weather Details" : "Advisories"} label="Weather advisory details"
    onClose={controller.clearSelection} closeLabel="Close weather details" contentLabel="Weather advisory details"
    icon={<><path d="M6 16a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 1 9" /><path d="m11 13-3 5h5l-2 4" /></>}>
      <GridPointDetails controller={controller} revision={revision} active={panel.open} />
      {surface.map(feature => <SurfaceDetails key={feature.id} feature={feature} controller={controller} />)}
      {advisories.map(a => {
        const record = state.products[a.product], status = sourceStatus(record, state.now);
        return <article className="awc-advisory-card" key={a.id} aria-label={advisoryTitle(a)}>
          <h3 className="awc-advisory-title">{advisoryHazard(a)}</h3>
          <p className="awc-advisory-identity">{advisoryTitle(a)} · <span>{a.issuer}</span></p>
          {a.validTo !== null && a.validTo <= state.now && <p className="awc-error">Expired</p>}
          <div className="awc-advisory-summary">
            <p>{a.altitude}</p>
            <p><span className="awc-advisory-time-label">{a.validTo === null ? 'Snapshot' : 'Valid'} </span>
              {a.validTo === null ? formatTimestamp(a.validFrom) : formatTimestampRange(a.validFrom, a.validTo)}</p>
          </div>
          {a.issuedAt !== null && <p className="awc-advisory-issued">Issued {formatTimestamp(a.issuedAt)}</p>}
          <p className={`awc-advisory-freshness${status.stale ? ' awc-error' : ''}`}>Source: {status.label}
            {status.age !== undefined && status.age >= 0 && ` · ${formatAge(status.age)} ago`}</p>
          {record.error && <p className="awc-error">{record.error}</p>}
          {a.text && <details className="awc-bulletin"><summary>{a.product === 'gairmet' ? 'Source text' : 'Full bulletin'}</summary>
            <pre>{a.text}</pre>
          </details>}
        </article>;
      })}
  </DetailPanel>;
}
