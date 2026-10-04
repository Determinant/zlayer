import type { Point } from '../../core/geo/route-corridor';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MAX_GLIDE_ALTITUDE, type GlidePreferences } from './preferences';
import type { GlideStatus } from './types';
import type { LandingStatus, LandingSite } from './landing-data';
import { formatDate } from '../../core/format/time';
import './styles.css';
export function glideSummary(status: GlideStatus, airportsEnabled: boolean): string {
  switch (status.state) {
    case 'idle': return 'Turn on to plan glide coverage';
    case 'loading': return airportsEnabled ? 'Checking airports and terrain…' : 'Checking terrain…';
    case 'zoom': return 'Zoom in to extend glide coverage';
    case 'error': return 'Glide coverage unavailable';
    case 'partial': return airportsEnabled ? `${status.airports ?? 0} airports · incomplete terrain or airport data` : 'Incomplete terrain data';
    case 'ready': return !airportsEnabled ? 'Airport coverage is off' : !status.route ? 'Add a route for airport glide coverage' : status.airports ? `${status.airports} airports within planning range` : 'No eligible airports within range at this altitude';
  }
}
export function landingSummary(status: LandingStatus): string {
  switch (status.state) {
    case 'idle': return 'Landing areas are off';
    case 'route': return 'Add a route or show a glide range to see landing candidates';
    case 'outside': return 'No prepared coverage in this view';
    case 'zoom': return 'Zoom in to load more landing areas';
    case 'loading': return status.totalFiles ? `Loading landing shading… ${status.loadedFiles ?? 0}/${status.totalFiles}` : 'Loading landing areas…';
    case 'unavailable': return 'Landing-area data has not been published yet';
    case 'error': return 'Landing-area data unavailable';
    case 'partial': return `${status.detail ? `${status.count ?? 0} candidate patches loaded` : 'Landing shading'} · coverage incomplete`;
    case 'limited': return status.detail && status.count ? `${status.count} candidate patches loaded · zoom in for more detail` : 'Overview limited · zoom in for more coverage';
    case 'ready': return status.detail ? (status.count ? `${status.count} candidate patches loaded` : 'No prepared candidates within the glide range in this view')
      : status.densityCells ? 'Landing-area density along your route' : 'No prepared candidates in this view';
  }
}
export function landingFlagText(flags: number): string[] {
  return ([
    [1, 'Crop conditions unverified'], [2, 'Shrub surface unverified'], [4, 'Broader shrub allowance'],
    [8, 'Tree-cover estimates disagree'], [16, 'Sloped or uneven ground'], [32, 'Developed open space'],
    [64, 'Narrower building setback'], [128, 'Bare or mixed surface unverified'],
    [256, 'Constrained fit or ground clearance'], [512, 'Reduced point-obstacle setback'], [1024, 'Opening corroborated despite conflicting cover classifications'],
  ] as const).filter(([bit]) => flags & bit).map(([, label]) => label);
}
export function GlideControls({ glideEnabled, glideAirportsEnabled, glideLandingsEnabled, glideRatio, glideAltitude, status, change, retry, landingStatus = { state: 'idle' }, retryLandings, point = null, site = null, clearPoint, reveal, visible = true }: GlidePreferences & {
  point?: Point | null; site?: LandingSite | null; clearPoint?(): void; reveal?(open: boolean): void; visible?: boolean;
  landingStatus?: LandingStatus; retryLandings?(): void;
  status: GlideStatus; change(patch: Partial<GlidePreferences>): void; retry(): void;
}) {
  const id = useId();
  const altitudeControl = useRef<HTMLInputElement>(null);
  const [focusAltitude, setFocusAltitude] = useState(false);
  useLayoutEffect(() => { if (point) { reveal?.(true); setFocusAltitude(true); } }, [point, reveal]);
  useEffect(() => {
    if (visible && focusAltitude) { altitudeControl.current?.focus({ preventScroll: true }); setFocusAltitude(false); }
  }, [visible, focusAltitude]);
  const [ratioDraft, setRatioDraft] = useState<string | null>(null);
  return <section className="glide-panel" aria-label="Glide Planner"
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <div className="glide-heading"><h3>Glide Planner</h3>
      <button type="button" className="ui-switch" role="switch" aria-label="Show glide coverage" aria-checked={glideEnabled}
        onClick={() => change({ glideEnabled: !glideEnabled })}><span className="switch" aria-hidden="true"><i /></span></button>
    </div>
    <div className="glide-group">
      <div className="glide-row"><label htmlFor={`${id}-airports`}>Airport coverage</label>
        <button id={`${id}-airports`} type="button" className="ui-switch" role="switch" aria-label="Show airport coverage" aria-checked={glideAirportsEnabled}
          onClick={() => change({ glideAirportsEnabled: !glideAirportsEnabled })}><span className="switch" aria-hidden="true"><i /></span></button>
      </div>
      <div className="glide-row"><label htmlFor={`${id}-landings`}>Off-field coverage</label>
        <button id={`${id}-landings`} type="button" className="ui-switch" role="switch" aria-label="Show off-field coverage" aria-checked={glideLandingsEnabled}
          onClick={() => change({ glideLandingsEnabled: !glideLandingsEnabled })}><span className="switch" aria-hidden="true"><i /></span></button>
      </div>
    </div>
    {point && <div className="glide-selected-point" aria-label="Selected glide point">
      <div><strong>{site ? 'Glide to selected area' : 'Glide from here'}</strong><output aria-label="Selected glide point coordinates">{Math.abs(point[1]).toFixed(3)}°{point[1] < 0 ? 'S' : 'N'} · {Math.abs(point[0]).toFixed(3)}°{point[0] < 0 ? 'W' : 'E'}</output>
        <p className="glide-note" aria-live="polite" aria-label="Selected point glide status">{!glideEnabled ? 'Glide coverage is off'
          : status.point === 'zoom' ? 'Zoom in to calculate point range'
          : status.point === 'outside' ? 'Point is outside the visible map'
          : status.point === 'partial' ? 'Terrain incomplete at selected point'
          : status.point === 'ready' ? site ? `${(status.pointRouteNm ?? 0).toFixed(1)} NM of route inside arrival range` : 'Using the planning altitude below' : status.state === 'error' ? 'Point range unavailable' : 'Checking terrain…'}</p>
        {site && <><output>{site.tier === 2 ? 'Preferred' : 'Last resort'} · {site.lengthFt.toLocaleString()} × {site.widthFt.toLocaleString()} ft fit</output>
          <p className="glide-note">Fit elevation up to {Math.round(site.elevationM / .3048).toLocaleString()} ft MSL.</p>
          {site.alongGradePercent !== undefined && site.crossGradePercent !== undefined && <p className="glide-note">Approx. overall grade: {Math.abs(site.alongGradePercent).toFixed(1)}% along · {Math.abs(site.crossGradePercent).toFixed(1)}% across the measured fit.</p>}
          <p className="glide-note">{landingFlagText(site.flags).join('; ') || 'No additional fallback flags'}.</p>
          <p className="glide-note">Dashed purple: arrival at the measured fit with 500 ft reserve. Fit dimensions do not establish stopping distance.</p></>}
      </div>
      <button type="button" className="ui-button ui-button--quiet ui-button--compact ui-button--icon" aria-label="Clear selected glide point" onClick={clearPoint}>×</button>
    </div>}
    <div className="glide-section glide-settings">
      <div className="glide-group">
        <div className="glide-row"><label htmlFor={`${id}-ratio`}>Glide ratio</label><span className="glide-value">
          <input id={`${id}-ratio`} className="ui-input ui-input--compact" type="number" inputMode="decimal" min="3" max="20" step="0.1"
            value={ratioDraft ?? glideRatio} onChange={event => setRatioDraft(event.currentTarget.value)}
            onBlur={() => {
              if (ratioDraft?.trim() && Number.isFinite(Number(ratioDraft))) change({ glideRatio: Math.round(Math.max(3, Math.min(20, Number(ratioDraft))) * 10) / 10 });
              setRatioDraft(null);
            }} onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === 'Escape') { event.stopPropagation(); setRatioDraft(null); }
            }} /><span>: 1</span></span></div>
        <p className="glide-note">8:1 is a conservative starting point.</p>
      </div>
      <div className="glide-group">
        <div className="glide-row glide-altitude"><label htmlFor={`${id}-altitude`}>Glide start altitude</label>
          <output htmlFor={`${id}-altitude`}>{glideAltitude.toLocaleString('en-US')} ft MSL</output></div>
        <input ref={altitudeControl} id={`${id}-altitude`} className="glide-slider" type="range" min="0" max={MAX_GLIDE_ALTITUDE} step="100"
          value={glideAltitude} aria-valuetext={`${glideAltitude.toLocaleString('en-US')} feet MSL`}
          onChange={event => change({ glideAltitude: Number(event.currentTarget.value) })} />
        <div className="glide-limits"><span>0 ft</span><span>18,000 ft</span></div>
        <p className="glide-note">Planning altitude for all glide ranges.</p>
        {glideEnabled && <p className="glide-note" aria-live="polite" aria-label="Ownship glide status">{status.ownship === 'ready' ? 'Ownship ring · live position, planning altitude'
          : status.ownship === 'partial' ? 'Ownship ring · terrain incomplete'
          : status.ownship === 'loading' ? 'Ownship ring · checking terrain…'
          : status.ownship === 'zoom' ? 'Zoom in to calculate ownship range'
          : status.ownship === 'outside' ? 'Ownship is outside the visible map' : 'Ownship ring needs a fresh GPS position'}</p>}
        <p className="glide-note" role="status" aria-label="Glide coverage status">{glideEnabled ? glideSummary(status, glideAirportsEnabled) : 'Glide coverage is off'}</p>
        {glideEnabled && (['error', 'partial'].includes(status.state) || status.ownship === 'partial' || status.point === 'partial') && <button className="ui-button ui-button--compact" type="button" onClick={retry}>Retry glide coverage</button>}
        {glideLandingsEnabled && <>
          <p className="glide-note" role="status" aria-label="Landing areas status">{glideEnabled ? landingSummary(landingStatus) : 'Glide coverage is off'}</p>
          {landingStatus.generatedAt && <small>Prepared {formatDate(landingStatus.generatedAt)}</small>}
          {glideEnabled && ['unavailable', 'error', 'partial', 'limited'].includes(landingStatus.state)
            && <button type="button" className="ui-button ui-button--compact" onClick={retryLandings}>Retry landing areas</button>}
        </>}
      </div>
    </div>
    <section className="glide-section" aria-label="Map legend">
      <h4>Map legend</h4>
      <div className="glide-group">
        {glideAirportsEnabled && <div className="glide-key"><i aria-hidden="true" /><span>Amber · Glide to airports</span></div>}
        <div className="glide-key glide-key-ownship"><i aria-hidden="true" /><span>Teal · Glide from ownship</span></div>
        {point && !site && <div className="glide-key glide-key-point"><i aria-hidden="true" /><span>Dashed teal · From selected point</span></div>}
        {glideLandingsEnabled && <>
          <div className="glide-key glide-key-landing-preferred"><i aria-hidden="true" /><span>Green · Preferred · {(landingStatus.preferredLengthFt ?? 2000).toLocaleString()}+ ft fit</span></div>
          <div className="glide-key glide-key-landing-last-resort"><i aria-hidden="true" /><span>Purple · Last-resort openings</span></div>
        </>}
        {point && site && <div className="glide-key glide-key-point glide-key-landing-last-resort"><i aria-hidden="true" /><span>Dashed purple · To selected area</span></div>}
      </div>
      {glideLandingsEnabled && <p>Stronger shading means more screened ground within 20 NM of your route. Green or purple shows the more common category. Detailed boundaries appear inside your ownship or selected glide range.</p>}
      {(!point || glideLandingsEnabled) && <p className="glide-note">Right-click or long-press the map:{' '}
        {!point && 'Show glide range plans from a point. '}
        {glideLandingsEnabled && 'Inspect landing area shows a detailed candidate’s fit and arrival range.'}
      </p>}
    </section>
    <details className="glide-section"><summary>Planning assumptions</summary>
      <p>Use your aircraft’s POH glide ratio and a planning margin. The 8:1 default is a conservative starting point for light singles.</p>
      <p>Still air and straight paths. Airport and selected-area coverage reserve 500 ft on arrival; all ranges use 200 ft terrain clearance. Ownship and selected-point ranges use the planning altitude, not GPS altitude. Terrain gaps cut coverage back. Outlines include a 0.1 NM inset and conservative smoothing.</p>
      <p>Airport coverage stays within 20 NM of your route and includes private and unpaved land runways. Check runway length, condition, permission and NOTAMs. Wind, turns, obstacles and landing maneuvers are not modeled.</p>
      {glideLandingsEnabled && <>
        <p><strong>Off-field areas.</strong> Screened candidates, not verified landing sites. Boundaries are approximate; visually inspect the ground and approach.</p>
        {(landingStatus.cultivated || landingStatus.shrub) && <p><strong>Surface.</strong> Includes {[
          landingStatus.cultivated && 'cultivated fields', landingStatus.shrub && 'scrub screened with stricter criteria',
        ].filter(Boolean).join(' and ')}. Current crops, vegetation and ground conditions are unverified.</p>}
        {(landingStatus.terrainFallback || landingStatus.urban || landingStatus.closeBuildings || landingStatus.mixedOpen || landingStatus.constrained) && <p><strong>Last resort.</strong> Areas may include {[
          landingStatus.terrainFallback && 'sloped or uneven ground', landingStatus.urban && 'developed open space',
          landingStatus.closeBuildings && 'smaller building setbacks',
          landingStatus.mixedOpen && 'unverified bare or mixed surfaces',
          landingStatus.constrained && 'shorter or narrower fits, or reduced ground clearance',
        ].filter(Boolean).join(', ')}.</p>}
        {landingStatus.obstacleUncertain && <p><strong>Obstacles.</strong> Some last-resort areas use reduced obstacle exclusions, including mast or position allowances. Visually check obstacle positions and clearance.</p>}
        {(landingStatus.canopyUncertain || landingStatus.coverUncertain) && <p><strong>Vegetation.</strong>{' '}
          {landingStatus.canopyUncertain && 'Tree-cover estimates conflict in some last-resort areas; trees may be present. '}
          {landingStatus.coverUncertain && 'Some openings have supporting open-ground evidence despite conflicting land-cover classifications.'}
        </p>}
        <p><strong>Coverage gaps.</strong> Unmarked ground may be unassessed or fail screening.
          {landingStatus.shrubEvidenceMissing && ' Shrubland with missing height or cover data is unassessed.'}
        </p>
      </>}
    </details>
  </section>;
}
