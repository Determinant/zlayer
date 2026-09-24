import { awcGridProduct, type AwcGridMode } from '@zlayer/contracts';
import { useId, useMemo } from 'react';
import { useLayerSnapshot } from '../../../core/layers/use-snapshot';
import { formatAge, formatTimestamp } from '../../../core/format/time';
import { magneticBearing, magneticField } from '../../../core/geo/magnetic-model';
import { useMagneticModel } from '../../../core/geo/use-magnetic-model';
import { fetchMagneticModel } from '../../../workspace/catalog/catalog';
import { forecastStreams, type WeatherController } from '../controller';
import { gridCell, gridValue, type DecodedGrid } from './format';
import { GRID_LABELS, forecastIsStale, preparationLabel, gridDescription, gridLegend, gridValueLabel, pointForecastGroups } from './presentation';
import { windSample } from './wind';
import { WIND_ALTITUDES, windLevelDescription, windLevelLabel } from './wind-levels';

// Toolbox categories are independent of the source family: freezing heights use HRRR.
const FIELDS: Record<'clouds' | 'icing' | 'winds', readonly Exclude<AwcGridMode, 'none'>[]> = {
  clouds: ['cloudCover', 'cloudBase', 'cloudTop'],
  icing: ['icingProbability', 'icingSeverity', 'sldPotential', 'freezingLowest', 'freezingHighest'],
  winds: ['temperature'],
};

function ForecastLevel({ levels, altitude, onChange, wind = false }: { levels: readonly number[]; altitude: number; onChange: (altitude: number) => void; wind?: boolean }) {
  const id = useId(), index = levels.indexOf(altitude), last = levels.length - 1;
  const label = wind ? 'Wind altitude' : 'Icing altitude';
  const describe = (level: number) => wind ? windLevelLabel(level) : `${level.toLocaleString('en-US')} ft MSL`;
  const unavailable = levels.length > 0 && index < 0;
  const nearest = levels.reduce((best, level) => Math.abs(level - altitude) < Math.abs(best - altitude) ? level : best, levels[0] ?? altitude);
  return <div className="awc-altitude" role="group" aria-label={`${label} selection`}>
    <div className="awc-altitude-heading"><label htmlFor={id}>{label}</label>
      <strong>{describe(altitude)}</strong></div>
    <input id={id} className="awc-time-slider" type="range" min={0} max={Math.max(1, last)} step={1}
      value={Math.max(0, index)} disabled={last <= 0 || index < 0}
      aria-valuetext={`${wind ? windLevelDescription(altitude) : `${altitude.toLocaleString('en-US')} feet MSL`}${unavailable ? ' · unavailable' : ''}`}
      onChange={e => { const level = levels[Number(e.currentTarget.value)]; if (level !== undefined) onChange(level); }} />
    <div className="awc-time-marks awc-altitude-marks" aria-hidden="true">{levels.map((level, i) => {
      const labeled = levels.length <= 6 || i === 0 || i === last || (wind
        ? [0.25, 0.5, 0.75].some(fraction => i === Math.round(last * fraction))
        : level % 10000 === 0 && i > last * 0.12 && i < last * 0.88);
      return <span className="awc-time-mark" key={level} data-selected={i === index || undefined}
        data-labeled={labeled || undefined} style={{ left: `${last > 0 ? i / last * 100 : 0}%` }} title={describe(level)}>
        <i />{labeled && <span>{wind && level >= 18000 ? `FL${level / 100}` : level < 1000 ? level : `${level / 1000}k`}</span>}
      </span>;
    })}</div>
    {unavailable && <><small>Selected altitude unavailable.</small>
      <button className="ui-button ui-button--compact" type="button" onClick={() => onChange(nearest)}>Use {describe(nearest)}</button></>}
  </div>;
}

export function GridControls({ controller, category }: { controller: WeatherController; category: 'clouds' | 'icing' | 'winds' }) {
  const state = useLayerSnapshot(controller), p = state.preferences;
  const mode = p.awcGridMode !== 'none' && FIELDS[category].includes(p.awcGridMode) ? p.awcGridMode : 'none';
  const product = category === 'winds' ? 'winds' : awcGridProduct(mode), grid = category === 'winds' ? state.wind : state.grid;
  const record = product && grid.products[product], manifest = record && record.manifest;
  const levels = category === 'winds' ? WIND_ALTITUDES
    : [...new Set(manifest?.frames.flatMap(f => f.altitudeFtMsl === null ? [] : [f.altitudeFtMsl]) ?? [])].sort((a, b) => a - b);
  const forecast = forecastStreams(state).find(forecast => forecast.product === product);
  const shown = forecast?.shown;
  const frame = shown?.frame, shownManifest = shown?.manifest ?? manifest;
  const updating = forecast?.loading || forecast?.rendering;
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  const stale = forecastIsStale(record, shownManifest, state.now, offline);
  const renderError = forecast?.renderError;
  return <section className="awc-grid-controls" aria-label={category === 'clouds' ? 'Cloud forecasts' : category === 'winds' ? 'Winds and temperatures aloft' : 'Icing and freezing forecasts'}>
    {category === 'winds' && <>
      <button className="ui-button ui-button--compact awc-grid-toggle" type="button" role="switch" aria-checked={p.awcWindBarbs}
        onClick={() => controller.change({ awcWindBarbs: !p.awcWindBarbs })}>
        <span>Show winds</span><span className="switch" aria-hidden="true"><i /></span>
      </button>
      <small>Barbs overlay clouds, icing and advisories. Spacing adjusts with zoom.</small>
      <ForecastLevel wind levels={levels} altitude={p.awcWindAltitude} onChange={awcWindAltitude => controller.change({ awcWindAltitude })} />
      <small>MSL below 18,000 ft · Flight levels from FL180.</small>
      <small>Half barb 5 kt · full barb 10 kt · flag 50 kt. Circle: &lt;2.5 kt.</small>
    </>}
    {category === 'winds' ? <button className="ui-button ui-button--compact awc-grid-toggle" type="button" role="switch"
      aria-checked={mode === 'temperature'} onClick={() => controller.change({ awcGridMode: mode === 'temperature' ? 'none' : 'temperature' })}>
      <span>Show temperature</span><span className="switch" aria-hidden="true"><i /></span>
    </button> : <label className="ui-field">Forecast overlay
      <select className="ui-input ui-input--compact" aria-label="Forecast overlay" value={mode}
        onChange={e => controller.change({ awcGridMode: e.currentTarget.value as AwcGridMode })}>
        <option value="none">None</option>
        {FIELDS[category].map(field => <option key={field} value={field}>{GRID_LABELS[field]}</option>)}
      </select>
    </label>}
    {product === 'icing' && <>
      <ForecastLevel levels={levels} altitude={p.awcGridAltitude} onChange={awcGridAltitude => controller.change({ awcGridAltitude })} />
      {p.awcGridMode !== 'sldPotential' && <button className="ui-button ui-button--compact awc-grid-toggle" type="button" role="switch"
        aria-checked={p.awcSldOverlay} onClick={() => controller.change({ awcSldOverlay: !p.awcSldOverlay })}>
        <span>SLD potential overlay</span><span className="switch" aria-hidden="true"><i /></span>
      </button>}
    </>}
    {mode === 'none' && p.awcGridMode !== 'none' && <p>{GRID_LABELS[p.awcGridMode]} is active. {category === 'winds' ? 'Temperature shading replaces it; wind barbs remain independent.' : 'Choosing a forecast here replaces it.'}</p>}
    {mode !== 'none' && <>
      <label className="ui-field">Opacity · {Math.round(p.awcGridOpacity * 100)}%<input type="range" className="awc-time-slider" aria-label="Forecast opacity"
        min={0.15} max={0.85} step={0.05} value={p.awcGridOpacity} onChange={e => controller.change({ awcGridOpacity: Number(e.currentTarget.value) })} /></label>
      <p>{gridDescription(mode)}</p>
      <div className="awc-grid-legend" aria-label={`${GRID_LABELS[mode]} legend`}>
        {gridLegend(mode).map(bin => <span key={bin.label}><i style={{ background: bin.color }} />{bin.label}</span>)}
      </div>
      <small>Right-click or long-press the map, then choose Inspect weather. Unshaded areas also have values. Inspection remains available when this toolbox is stowed.</small>
      {product === 'icing' && p.awcSldOverlay && p.awcGridMode !== 'sldPotential' && <small>Red hatch: SLD potential &gt; 0</small>}
    </>}
    {(mode !== 'none' || category === 'winds' && p.awcWindBarbs) && <div className="awc-grid-status" role="status">
        <strong>{renderError ? 'Forecast display unavailable' : grid.error ? 'Forecast unavailable' : updating ? 'Loading forecast…' : frame ? `Valid ${formatTimestamp(frame.validTime)}`
          : record && record.loading ? 'Checking forecast times…' : 'No forecast available for this time / altitude'}</strong>
        {shownManifest && <span>{shownManifest.model} run {formatTimestamp(shownManifest.runTime)}</span>}
        {!!grid.preparation?.total && <span>{preparationLabel(grid.preparation)}
          {!!grid.preparation.failed && ` · ${grid.preparation.failed} awaiting retry`}</span>}
        {shownManifest && <span className={stale ? 'awc-error' : undefined}>{offline ? 'Offline · cached' : stale ? 'Cached / outdated' : 'Checked'} · source checked {formatAge(state.now - shownManifest.checkedAt)} ago</span>}
        {(renderError || grid.error || record && record.error) && <span className="awc-error">{renderError || grid.error || record && record.error}</span>}
        {record && record.storageError && <span className="awc-error">{record.storageError}</span>}
        {grid.preparation?.error && <span className="awc-error">{grid.preparation.error}</span>}
      </div>}
  </section>;
}

export function GridPointDetails({ controller, revision, active = true }: {
  controller: WeatherController; revision?: string | undefined; active?: boolean;
}) {
  const state = useLayerSnapshot(controller), point = state.gridPoint;
  const data = [state.gridDisplay?.data, state.windDisplay].filter((d): d is DecodedGrid => !!d);
  const unique = data.filter((d, i) => !data.slice(0, i).some(other => other.manifest.product === d.manifest.product));
  const wind = unique.find(data => data.manifest.product === 'winds');
  const magneticModel = useMagneticModel(revision, active && !!point && !!wind, fetchMagneticModel);
  // Like the ruler, evaluate at zero ellipsoid height: forecast geopotential MSL
  // height is not a WGS84 ellipsoid altitude. Status updates do not reevaluate WMM.
  const field = useMemo(() => point && wind && magneticModel
    ? magneticField(magneticModel, [point.longitude, point.latitude], 0, wind.frame.validTime) : null,
  [magneticModel, point?.longitude, point?.latitude, wind?.frame.validTime]);
  if (!point) return null;
  if (!unique.length) return <p>Forecast unavailable for this selection.</p>;
  const declination = field && field.horizontal >= 6000 && Math.abs(point.latitude) < 90 ? field.declination : null;
  const groups = pointForecastGroups(unique);
  return <article className="awc-advisory-card" aria-label="Forecast at selected point">
    <h3>Forecast at this point</h3>
    <p className="awc-advisory-hazard">{point.latitude.toFixed(3)}°, {point.longitude.toFixed(3)}°</p>
    {groups.map(data => <ForecastPointGroup key={data[0]!.manifest.product} state={state} data={data}
      declination={declination} heading={groups.length > 1} onAltitude={controller.showAltitudeControls} />)}
  </article>;
}

const POINT_PRODUCTS = { clouds: 'Clouds and freezing', icing: 'Icing', winds: 'Winds and temperature aloft' } as const;

function ForecastPointGroup({ state, data, declination, heading, onAltitude }: {
  state: ReturnType<WeatherController['getSnapshot']>; data: readonly DecodedGrid[]; declination: number | null; heading: boolean;
  onAltitude: WeatherController['showAltitudeControls'];
}) {
  const point = state.gridPoint!, first = data[0]!;
  const samples = data.map(data => {
    const wind = data.manifest.product === 'winds', cell = gridCell(data.manifest, point.longitude, point.latitude);
    const record = (wind ? state.wind : state.grid).products[data.manifest.product];
    const sample = wind && cell !== undefined ? windSample(gridValue(data, 'windEast', cell), gridValue(data, 'windNorth', cell)) : undefined;
    return { data, wind, cell, sample,
      stale: forecastIsStale(record, data.manifest, state.now, typeof navigator !== 'undefined' && !navigator.onLine) };
  });
  const sameCheck = samples.every(({ data, stale }) => data.manifest.checkedAt === first.manifest.checkedAt && stale === samples[0]!.stale);
  const direction = (degrees: number) => String(Math.round(degrees) || 360).padStart(3, '0');
  const windDirection = (sample: NonNullable<ReturnType<typeof windSample>>) => sample.barb === 0 ? 'Calm'
    : `${declination === null ? '—' : `${direction(magneticBearing(sample.direction, declination))}°M`} / ${direction(sample.direction)}°T`;
  return <section className="awc-point-forecast" aria-label={data.map(data => POINT_PRODUCTS[data.manifest.product]).join(' · ')}>
      {heading && <h4>{data.map(data => POINT_PRODUCTS[data.manifest.product]).join(' · ')}</h4>}
      <dl>
        <div className="is-wide"><dt>Valid</dt><dd>{formatTimestamp(first.frame.validTime)}</dd></div>
        <div className="is-wide"><dt>Model run</dt><dd>{first.manifest.model} · {formatTimestamp(first.manifest.runTime)}</dd></div>
        {samples.map(({ data, wind, cell, sample }) => cell === undefined
          ? <div className="is-wide" key={data.manifest.product}><dt>{POINT_PRODUCTS[data.manifest.product]}</dt><dd>Forecast unavailable for this selection.</dd></div>
          : <ForecastPointValues key={data.manifest.product} data={data} cell={cell} wind={wind}
            windLabel={sample ? `${windDirection(sample)} · ${sample.speed.toFixed(1)} kt` : undefined} onAltitude={onAltitude} />)}
      </dl>
      {(sameCheck ? samples.slice(0, 1) : samples).map(({ data, stale }) => <p className="awc-advisory-freshness" key={data.manifest.product}>
        {!sameCheck && `${POINT_PRODUCTS[data.manifest.product]} · `}Source checked {formatTimestamp(data.manifest.checkedAt)}
        {stale && ' · Cached / outdated'}</p>)}
      {samples.filter(({ cell }) => cell !== undefined).map(({ data, wind, sample }) => <p className="awc-advisory-freshness" key={data.manifest.product}>
        {wind ? `${declination === null && sample && sample.barb !== 0 ? 'Magnetic variation unavailable. ' : ''}Wind directions are magnetic / true, from which the wind blows.`
          : data.manifest.product === 'clouds' ? 'Heights MSL; bases are not ceilings. Coverage is the full atmospheric column.'
            : 'SLD is a potential index, not a probability. Altitudes follow the model terrain.'}</p>)}
      <details className="awc-bulletin"><summary>Source &amp; sampling</summary>
        {samples.map(({ data, wind }) => <div key={data.manifest.product}>
          {wind && <p>{data.frame.pressureHpa !== undefined ? `Flight level at ${data.frame.pressureHpa.toFixed(1)} hPa. Components and temperature interpolate in log pressure; forecast MSL height varies across the map.`
            : 'Components and temperature interpolate between pressure levels using forecast MSL heights at this location.'} Missing or unbracketed samples remain unavailable.</p>}
          <p>{POINT_PRODUCTS[data.manifest.product]}: {wind ? 'Nearest horizontal sample on the converted grid. Source components rounded to 0.1 kt, temperature to 0.1°C and heights to 10 ft before vertical interpolation. Speed and direction are calculated from the interpolated components; barbs show the nearest 5 kt.'
            : 'Nearest model sample on the converted grid. Heights rounded to 10 ft; coverage and icing probability to 1%; SLD to 0.01.'}</p>
        </div>)}
      </details>
  </section>;
}

function ForecastPointValues({ data, cell, wind, windLabel, onAltitude }: {
  data: DecodedGrid; cell: number; wind: boolean; windLabel: string | undefined; onAltitude: WeatherController['showAltitudeControls'];
}) {
  const altitude = 'windAltitude' in data.frame ? windLevelLabel(data.frame.windAltitude)
    : data.frame.altitudeFtMsl !== null ? `${data.frame.altitudeFtMsl.toLocaleString('en-US')} ft MSL` : undefined;
  const product = wind ? 'winds' : 'icing', label = wind ? 'Wind altitude' : 'Icing altitude';
  return <>
    {altitude && <div className="is-wide"><dt>{label}</dt><dd className="awc-point-altitude"><span>{altitude}</span>
      <button type="button" className="ui-button ui-button--quiet ui-button--compact" aria-label={`Change ${label.toLowerCase()}`}
        title={`Open ${wind ? 'Winds' : 'Icing'} altitude controls`} onClick={() => onAltitude(product)}>Change</button>
    </dd></div>}
    {wind && <div className="is-wide"><dt>Wind</dt><dd>{windLabel ?? gridValueLabel('windEast', gridValue(data, 'windEast', cell))}</dd></div>}
    {data.manifest.fields.filter(field => field !== 'windEast' && field !== 'windNorth').map(field =>
      <div className="is-wide" key={field}><dt>{GRID_LABELS[field]}</dt><dd>{gridValueLabel(field, gridValue(data, field, cell))}</dd></div>)}
  </>;
}
