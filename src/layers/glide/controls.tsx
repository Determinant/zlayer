import type { Point } from '../../core/geo/route-corridor';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MAX_GLIDE_ALTITUDE, type GlidePreferences } from './preferences';
import type { GlideStatus } from './types';
import type { LandingStatus } from './landing-data';
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
    case 'route': return 'Add a route to see landing candidates';
    case 'outside': return 'No prepared coverage along the route in this view';
    case 'zoom': return 'Zoom in to load more landing areas';
    case 'loading': return 'Loading landing areas…';
    case 'unavailable': return 'Landing-area data has not been published yet';
    case 'error': return 'Landing-area data unavailable';
    case 'partial': return `${status.count ?? 0} candidate patches loaded · coverage incomplete`;
    case 'limited': return 'Area display limit reached · zoom in for more detail';
    case 'ready': return status.count ? `${status.count} candidate patches loaded` : 'No prepared candidates in this view';
  }
}
export function GlideControls({ glideEnabled, glideAirportsEnabled, glideLandingsEnabled, glideRatio, glideAltitude, status, change, retry, landingStatus = { state: 'idle' }, retryLandings, point = null, clearPoint, reveal, visible = true }: GlidePreferences & {
  point?: Point | null; clearPoint?(): void; reveal?(open: boolean): void; visible?: boolean;
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
      <div><strong>Glide from here</strong><output aria-label="Selected glide point coordinates">{Math.abs(point[1]).toFixed(3)}°{point[1] < 0 ? 'S' : 'N'} · {Math.abs(point[0]).toFixed(3)}°{point[0] < 0 ? 'W' : 'E'}</output>
        <p className="glide-note" aria-live="polite" aria-label="Selected point glide status">{!glideEnabled ? 'Glide coverage is off'
          : status.point === 'zoom' ? 'Zoom in to calculate point range'
          : status.point === 'outside' ? 'Point is outside the visible map'
          : status.point === 'partial' ? 'Terrain incomplete at selected point'
          : status.point === 'ready' ? 'Using the planning altitude below' : status.state === 'error' ? 'Point range unavailable' : 'Checking terrain…'}</p></div>
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
      </div>
    </div>
    <div className="glide-section">
      {glideAirportsEnabled && <div className="glide-key"><i aria-hidden="true" /><span>To airports · within 20 NM of route</span></div>}
      <div className="glide-key glide-key-ownship"><i aria-hidden="true" /><span>From ownship · planning altitude</span></div>
      {point && <div className="glide-key glide-key-point"><i aria-hidden="true" /><span>From selected point · dashed teal</span></div>}
      {glideEnabled && <p className="glide-note" aria-live="polite" aria-label="Ownship glide status">{status.ownship === 'ready' ? 'Ownship ring · live position, planning altitude'
        : status.ownship === 'partial' ? 'Ownship ring · terrain incomplete'
        : status.ownship === 'loading' ? 'Ownship ring · checking terrain…'
        : status.ownship === 'zoom' ? 'Zoom in to calculate ownship range'
        : status.ownship === 'outside' ? 'Ownship is outside the visible map' : 'Ownship ring needs a fresh GPS position'}</p>}
      <p className="glide-note" role="status" aria-label="Glide coverage status">{glideEnabled ? glideSummary(status, glideAirportsEnabled) : 'Glide coverage is off'}</p>
      {glideEnabled && (['error', 'partial'].includes(status.state) || status.ownship === 'partial' || status.point === 'partial') && <button className="ui-button ui-button--compact" type="button" onClick={retry}>Retry glide coverage</button>}
      {!point && <p className="glide-note">Right-click or long-press the map, then choose Show glide range to plan from any point.</p>}
    </div>
    {glideLandingsEnabled && <div className="glide-section" aria-label="Off-field landing candidates">
      <h4>Possible landing areas</h4>
      <div className="glide-key glide-key-landing-preferred"><i aria-hidden="true" /><span>Preferred · {(landingStatus.preferredLengthFt ?? 2000).toLocaleString()}+ ft fit</span></div>
      <div className="glide-key glide-key-landing-last-resort"><i aria-hidden="true" /><span>Best effort · 1,500+ ft fit</span></div>
      <p>Within 20 NM of your route. These areas do not show glide reachability and stay the same as you change altitude.</p>
      <p className="glide-note" role="status" aria-label="Landing areas status">{glideEnabled ? landingSummary(landingStatus) : 'Glide coverage is off'}</p>
      {landingStatus.generatedAt && <small>Prepared {formatDate(landingStatus.generatedAt)}</small>}
      {landingStatus.cultivated && <p>Includes cultivated fields; current crop and surface conditions are unverified.</p>}
      {landingStatus.shrub && <p>Includes scrub selected after stricter screening. Vegetation and surface conditions remain uncertain.</p>}
      {(landingStatus.terrainFallback || landingStatus.urban || landingStatus.closeBuildings) && <p>Some best-effort areas use {[
        landingStatus.terrainFallback && 'smooth-slope allowances', landingStatus.urban && 'developed open space',
        landingStatus.closeBuildings && 'narrower building setbacks',
      ].filter(Boolean).join(', ')}.</p>}
      {landingStatus.canopyUncertain && <p>Some best-effort areas have conflicting tree-cover estimates. Trees may still be present.</p>}
      <p>Screened candidates, not verified landing sites. Boundaries are approximate; inspect the area and approach.</p>
      {glideEnabled && ['unavailable', 'error', 'partial', 'limited'].includes(landingStatus.state)
        && <button type="button" className="ui-button ui-button--compact" onClick={retryLandings}>Retry landing areas</button>}
    </div>}
    <details className="glide-section"><summary>Planning assumptions</summary>
      <p>Use your aircraft’s POH glide ratio and a planning margin. The 8:1 default is a conservative starting point for light singles.</p>
      <p>Still air and straight paths. Airport coverage reserves 500 ft on arrival; all ranges use 200 ft terrain clearance. Ownship and selected-point ranges use the planning altitude, not GPS altitude. Terrain gaps cut coverage back. Outlines include a 0.1 NM inset and conservative smoothing.</p>
      <p>Includes private and unpaved land runways. Check runway length, condition, permission and NOTAMs. Wind, turns, obstacles and landing maneuvers are not modeled.</p>
    </details>
  </section>;
}
