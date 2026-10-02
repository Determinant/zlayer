import type { Point } from '../../core/geo/route-corridor';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MAX_GLIDE_ALTITUDE, type GlidePreferences } from './preferences';
import type { GlideStatus } from './types';
import './styles.css';
export function glideSummary(status: GlideStatus): string {
  switch (status.state) {
    case 'idle': return 'Turn on to plan airport glide coverage';
    case 'loading': return 'Checking airports and terrain…';
    case 'zoom': return 'Zoom in to extend glide coverage';
    case 'error': return 'Glide coverage unavailable';
    case 'partial': return `${status.airports ?? 0} airports · incomplete terrain or airport data`;
    case 'ready': return !status.route ? 'Add a route for airport glide coverage' : status.airports ? `${status.airports} airports within planning range` : 'No eligible airports within range at this altitude';
  }
}
export function GlideControls({ glideEnabled, glideRatio, glideAltitude, status, change, retry, point = null, clearPoint, reveal, visible = true }: GlidePreferences & {
  point?: Point | null; clearPoint?(): void; reveal?(open: boolean): void; visible?: boolean;
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
    <div className="glide-heading"><strong>Glide Planner</strong>
      <button type="button" className="ui-switch" role="switch" aria-label="Show glide coverage" aria-checked={glideEnabled}
        onClick={() => change({ glideEnabled: !glideEnabled })}><span className="switch" aria-hidden="true"><i /></span></button>
    </div>
    <p>Airport coverage along your route, plus glide range from ownship.</p>
    {point && <div className="glide-selected-point" aria-label="Selected glide point">
      <div><strong>Glide from here</strong><output aria-label="Selected glide point coordinates">{Math.abs(point[1]).toFixed(3)}°{point[1] < 0 ? 'S' : 'N'} · {Math.abs(point[0]).toFixed(3)}°{point[0] < 0 ? 'W' : 'E'}</output>
        <small aria-live="polite" aria-label="Selected point glide status">{!glideEnabled ? 'Glide coverage is off'
          : status.state === 'zoom' ? 'Zoom in to calculate point range'
          : status.point === 'outside' ? 'Point is outside the visible map'
          : status.point === 'partial' ? 'Terrain incomplete at selected point'
          : status.point === 'ready' ? 'Using the planning altitude below' : status.state === 'error' ? 'Point range unavailable' : 'Checking terrain…'}</small></div>
      <button type="button" className="ui-button ui-button--quiet ui-button--icon" aria-label="Clear selected glide point" onClick={clearPoint}>×</button>
    </div>}
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
    <small>8:1 conservative starting point for light singles. Use your aircraft’s POH and planning margin.</small>
    <div className="glide-row"><label htmlFor={`${id}-altitude`}>Glide start altitude</label>
      <output htmlFor={`${id}-altitude`}>{glideAltitude.toLocaleString('en-US')} <small>ft MSL</small></output></div>
    <input ref={altitudeControl} id={`${id}-altitude`} className="glide-slider" type="range" min="0" max={MAX_GLIDE_ALTITUDE} step="100"
      value={glideAltitude} aria-valuetext={`${glideAltitude.toLocaleString('en-US')} feet MSL`}
      onChange={event => change({ glideAltitude: Number(event.currentTarget.value) })} />
    <div className="glide-limits"><span>0 ft</span><span>18,000 ft</span></div>
    <div className="glide-key"><i aria-hidden="true" /><span>To airports · within 20 NM of route</span></div>
    <div className="glide-key glide-key-ownship"><i aria-hidden="true" /><span>From ownship · planning altitude</span></div>
    {point && <div className="glide-key glide-key-point"><i aria-hidden="true" /><span>From selected point · dashed teal</span></div>}
    <small>All ranges use {glideAltitude.toLocaleString('en-US')} ft MSL from the slider.</small>
    {glideEnabled && <small aria-live="polite" aria-label="Ownship glide status">{status.ownship === 'ready' ? 'Ownship ring · live position, planning altitude'
      : status.ownship === 'partial' ? 'Ownship ring · terrain incomplete'
      : status.ownship === 'loading' ? 'Ownship ring · checking terrain…'
      : status.ownship === 'outside' ? 'Ownship is outside the visible map' : 'Ownship ring needs a fresh GPS position'}</small>}
    <p role="status" aria-label="Glide coverage status">{glideEnabled ? glideSummary(status) : 'Glide coverage is off'}</p>
    {glideEnabled && (['error', 'partial'].includes(status.state) || status.ownship === 'partial' || status.point === 'partial') && <button className="ui-button ui-button--compact" type="button" onClick={retry}>Retry glide coverage</button>}
    {!point && <small>Right-click or long-press the map, then choose Show glide range to plan from any point.</small>}
    <details><summary>Planning assumptions</summary>
      <p>Still air and straight paths. Airport coverage reserves 500 ft on arrival; all ranges use 200 ft terrain clearance. Ownship and selected-point ranges use the planning altitude, not GPS altitude. Terrain gaps cut coverage back. Outlines include a 0.1 NM inset and conservative smoothing.</p>
      <p>Includes private and unpaved land runways. Check runway length, condition, permission and NOTAMs. Wind, turns, obstacles and landing maneuvers are not modeled.</p>
    </details>
  </section>;
}
