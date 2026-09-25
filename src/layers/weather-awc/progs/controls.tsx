import { SURFACE_PRODUCTS, type SurfaceBoundary, type SurfaceFeature } from '@zlayer/contracts';
import { useLayerSnapshot } from '../../../core/layers/use-snapshot';
import { formatAge, formatTimestamp } from '../../../core/format/time';
import type { WeatherController } from '../controller';
import { surfaceStatus } from './time';
import { isSurfacePressureLabel, SURFACE_COLORS, SURFACE_LABELS } from './palette';

function BoundaryLegend({ kind }: { kind: SurfaceBoundary }) {
  const color = SURFACE_COLORS[kind];
  return <svg viewBox="0 0 54 24" aria-hidden="true">
    <path d={kind === 'STNRY' ? 'M0 12H27' : 'M0 12H54'} fill="none" stroke={color} strokeWidth="2" strokeDasharray={kind === 'TROF' || kind === 'SQUALL' ? '6 4' : undefined} />
    {kind === 'STNRY' && <path d="M27 12H54" stroke={SURFACE_COLORS.WARM} strokeWidth="2" />}
    {(kind === 'COLD' || kind === 'OCFNT' || kind === 'STNRY') && <path d="M9 12L14 5L19 12Z" fill={color} />}
    {kind === 'COLD' && <path d="M35 12L40 5L45 12Z" fill={color} />}
    {kind === 'WARM' && <path d="M9 12A5 5 0 0 1 19 12Z" fill={color} />}
    {(kind === 'WARM' || kind === 'OCFNT') && <path d="M35 12A5 5 0 0 1 45 12Z" fill={color} />}
    {kind === 'DRYLINE' && <path d="M9 12A5 5 0 0 1 19 12M35 12A5 5 0 0 1 45 12" fill="none" stroke={color} strokeWidth="2" />}
    {kind === 'SQUALL' && <><circle cx="14" cy="12" r="3" fill={color} /><circle cx="40" cy="12" r="3" fill={color} /></>}
    {kind === 'STNRY' && <path d="M35 12A5 5 0 0 0 45 12Z" fill={SURFACE_COLORS.WARM} />}
  </svg>;
}

export function ProgsControls({ controller }: { controller: WeatherController }) {
  const state = useLayerSnapshot(controller), { frame, product, nextTime } = controller.surfaceSelection();
  const record = state.progs[product], coverage = controller.coverageSelection();
  const coverageState = state.coverage, display = state.coverageDisplay;
  const coverageStale = coverageState.restored || !!coverageState.error || !coverageState.snapshot ||
    state.now < coverageState.snapshot.checkedAt || state.now - coverageState.snapshot.checkedAt > 10 * 60_000;
  return <div className="awc-progs-controls">
    <button type="button" role="switch" aria-checked={state.preferences.awcProgs}
      className="ui-button ui-button--quiet ui-button--slim awc-progs-toggle" onClick={() => controller.change({ awcProgs: !state.preferences.awcProgs })}>
      <span>Surface analysis / progs</span><span className="switch" aria-hidden="true"><i /></span>
    </button>
    <small>Now shows the latest analysis. Use the timeline for forecast charts and weather coverage.</small>
    {state.preferences.awcProgs && <>
      <button type="button" role="switch" aria-checked={state.preferences.awcProgsIsobars}
        className="ui-button ui-button--quiet ui-button--slim awc-progs-toggle" onClick={() => controller.change({ awcProgsIsobars: !state.preferences.awcProgsIsobars })}>
        <span>Isobars</span><span className="switch" aria-hidden="true"><i /></span>
      </button>
      <button type="button" role="switch" aria-checked={state.preferences.awcProgsCoverage}
        className="ui-button ui-button--quiet ui-button--slim awc-progs-toggle" onClick={() => controller.change({ awcProgsCoverage: !state.preferences.awcProgsCoverage })}>
        <span>Precipitation / weather</span><span className="switch" aria-hidden="true"><i /></span>
      </button>
      {state.preferences.awcProgsCoverage && <>
        <div className="awc-coverage-status" role="status">
          <strong>NDFD weather · CONUS</strong>
          <span>{display.validTime !== undefined ? `Shown · valid ${formatTimestamp(display.validTime)}`
            : display.loading || coverageState.loading ? 'Loading weather coverage…'
            : display.error || coverageState.error ? 'Weather coverage unavailable'
            : coverage && !coverage.file ? 'Weather coverage not published for this chart'
            : 'No weather coverage for this time'}</span>
          {coverageState.snapshot && <small>{coverageState.loading ? 'Refreshing…' : coverageStale ? 'Cached / unverified' : 'Checked'}</small>}
          {(display.error || coverageState.error) && <small className="awc-error">{display.error || coverageState.error}</small>}
        </div>
        <details className="awc-coverage-legend"><summary>Weather coverage legend</summary>
          <table><thead><tr><th>Precipitation</th><th>Chance</th><th>Likely</th></tr></thead><tbody>
            {([['Rain', '#009641', '#065d2c'], ['Snow', '#0570b0', '#081d58'], ['Mix', '#b66dff', '#490092'], ['Ice', '#ff72b9', '#e40072']] as const)
              .map(([name, chance, likely]) => <tr key={name}><th>{name}</th><td><i style={{ backgroundColor: chance }} /></td><td><i style={{ backgroundColor: likely }} /></td></tr>)}
          </tbody></table>
          <div>{([['Severe thunderstorms', '#99000d'], ['Haze', '#cdcbd3'], ['Smoke', '#8e8981'], ['Fog', '#f0e442'], ['Dust', '#924900']] as const)
            .map(([name, color]) => <span key={name}><i style={{ backgroundColor: color }} />{name}</span>)}</div>
          <small>Chance: up to 50%; likely: over 50%. NOAA forecast coverage; transparent areas do not establish clear conditions.</small>
        </details>
      </>}
      <div className="awc-progs-frame" role="status">
        <strong>{product === 'analysis' ? 'Surface analysis' : 'Surface forecast'}</strong>
        <span>{frame ? `Valid ${formatTimestamp(frame.validTime)}` : record.loading ? 'Loading surface weather…'
          : record.error ? 'Surface weather unavailable'
          : product === 'analysis' ? 'No current analysis available' : 'No surface forecast for this time'}</span>
        {frame && nextTime && <small>Next chart {formatTimestamp(nextTime)}</small>}
        {frame && <small>{frame.features.length} features · {surfaceStatus(record, state.now).label}</small>}
      </div>
      {state.progsRenderError && <div className="awc-error" role="status">{state.progsRenderError}</div>}
      {(state.progsRenderError || state.preferences.awcProgsCoverage && (display.error || coverageState.error) || SURFACE_PRODUCTS.some(p => state.progs[p].error)) &&
        <button type="button" className="ui-button ui-button--slim" onClick={() => controller.retryProgs()}>Retry surface weather</button>}
      <div className="awc-surface-legend" aria-label="Surface weather legend">
        {(['COLD', 'WARM', 'STNRY', 'OCFNT', 'TROF', 'DRYLINE', 'SQUALL'] as const).map(kind => <span key={kind}>
          <BoundaryLegend kind={kind} />{SURFACE_LABELS[kind]}
        </span>)}
        <span><b aria-hidden="true"><i className="awc-front-cold">H</i> / <i className="awc-front-warm">L</i></b> Pressure centers</span>
        {state.preferences.awcProgsIsobars && <span><svg viewBox="0 0 54 24" aria-hidden="true"><path d="M0 18Q27 0 54 18" fill="none" stroke={SURFACE_COLORS.ISOBAR} /></svg>Isobars · hPa</span>}
      </div>
      <small>NOAA pressure contours show ridges and troughs. Chart labels retain the source annotations; dashed fronts indicate formation or weakening.</small>
      <details className="awc-source-status"><summary>Progs source status</summary>
        {SURFACE_PRODUCTS.map(p => {
          const value = state.progs[p], status = surfaceStatus(value, state.now);
          return <div key={p} className="awc-product-status" data-product={`progs-${p}`}>
            <strong>{p === 'analysis' ? 'WPC analysis' : 'WPC forecast'}</strong>
            <span>{status.label}{status.age !== undefined && status.age >= 0 ? ` · ${formatAge(status.age)} ago` : ''}</span>
            {value.snapshot && <small>{value.snapshot.frames.length} chart{value.snapshot.frames.length === 1 ? '' : 's'} · through {formatTimestamp(value.snapshot.frames.at(-1)!.validTime)}</small>}
            {value.error && <small className="awc-error">{value.error}</small>}
          </div>;
        })}
        {state.preferences.awcProgsCoverage && coverageState.snapshot && <div className="awc-product-status" data-product="progs-coverage">
          <strong>NDFD weather coverage</strong>
          <span>Source checked {formatTimestamp(coverageState.snapshot.checkedAt)}</span>
          <small>{coverageState.snapshot.frames.filter(frame => frame.file).length} published images · missing images remain gaps</small>
        </div>}
        <a href="https://aviationweather.gov/gfa/help/" target="_blank" rel="noreferrer">AWC weather coverage guide</a>
        <a href="https://www.wpc.ncep.noaa.gov/html/sfc2.shtml" target="_blank" rel="noreferrer">NOAA / Weather Prediction Center</a>
      </details>
    </>}
  </div>;
}

export function SurfaceDetails({ feature, controller }: { feature: SurfaceFeature; controller: WeatherController }) {
  const selection = controller.surfaceSelection();
  return <article className="awc-advisory-card" aria-label={SURFACE_LABELS[feature.kind]}>
    <h3>{SURFACE_LABELS[feature.kind]}</h3>
    {'text' in feature && <p>{feature.text}{isSurfacePressureLabel(feature) ? ' hPa' : ''}</p>}
    {'phase' in feature && feature.phase !== 'normal' && <p>{feature.phase === 'forming' ? 'Frontogenesis (forming)' : 'Frontolysis (weakening)'}</p>}
    <p>{selection.product === 'analysis' ? 'WPC surface analysis' : 'WPC surface forecast'}</p>
    {selection.frame && <p>Valid {formatTimestamp(selection.frame.validTime)}</p>}
    {selection.frame && <p className="awc-advisory-freshness">Reference cycle {formatTimestamp(selection.frame.referenceTime)}</p>}
    <details className="awc-bulletin"><summary>Source properties</summary><pre>{JSON.stringify(feature.sourceProperties, null, 2)}</pre></details>
  </article>;
}
