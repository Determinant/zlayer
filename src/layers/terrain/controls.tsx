import type { TerrainStatus } from './types';
import { terrainColor, TERRAIN_COLOR_STOPS } from './palette';
import { useEffect, useId, useRef, useState } from 'react';
import { CLEARANCE_COLORS, DEFAULT_TERRAIN_ALTITUDE, MAX_TERRAIN_ALTITUDE, TERRAIN_ALTITUDE_STEP } from './clearance';
import './styles.css';

const TERRAIN_SLIDER_STEP = 500;

export function terrainSummary(status: TerrainStatus): string {
  if (status.state === 'idle') return 'Add a route to see terrain';
  if (status.state === 'zoom') return 'Zoom in to see contours';
  if (status.state === 'loading') return 'Loading route elevation…';
  if (status.state === 'error') return 'Terrain incomplete · elevation unavailable';
  return `${status.interval.toLocaleString('en-US')} ft ${status.overview ? 'bands' : 'contours'} · 4 NM core / 8 NM fade`;
}

export function TerrainControls({ enabled, status, onToggle }: {
  enabled: boolean; status: TerrainStatus; onToggle: () => void;
}) {
  return <section className="layer-section terrain-section">
    <div className="section-title"><h3>Route terrain</h3>
      <div className="terrain-section-meta"><span>Feet MSL</span><TerrainHelp /></div>
    </div>
    <div className="toggle-list">
      <button className={enabled ? 'is-active' : ''} type="button" role="switch" aria-checked={enabled} onClick={onToggle}>
        <span className="terrain-swatch" aria-hidden="true">△</span>
        <span className="layer-copy"><strong>Elevation contours</strong><small>{enabled ? terrainSummary(status) : 'Off'}</small></span>
        <span className="switch" aria-hidden="true"><i /></span>
      </button>
    </div>
  </section>;
}

function TerrainHelp() {
  const id = useId();
  const target = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !target.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    // Dismiss this help before Escape reaches the enclosing layers menu.
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return <div className="terrain-info" ref={target}
    onPointerEnter={event => { if (event.pointerType !== 'touch') setOpen(true); }}
    onPointerLeave={event => {
      if (event.pointerType !== 'touch' && !event.currentTarget.contains(document.activeElement)) setOpen(false);
    }}
    onFocus={() => setOpen(true)} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
    <button className="terrain-info-trigger" type="button" aria-label="About route terrain"
      aria-expanded={open} aria-controls={id} aria-describedby={open ? id : undefined} onClick={() => setOpen(true)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7v.5" /></svg>
    </button>
    {open && <div className="terrain-help" id={id} role="tooltip">
      <p>1,000 ft contours; zoom in for 500 ft detail. Full color within 4 NM of each leg, fading out by 8 NM.</p>
      <p>^ marks sampled highs, rounded up to 100 ft. Elevation mode leaves terrain below the first contour unshaded.</p>
      <p>Clearance compares your selected MSL altitude with terrain. Areas with 2,000 ft+ clearance are unshaded.</p>
    </div>}
  </div>;
}

export function TerrainLegend({ status, altitude, onAltitudeChange }: {
  status: TerrainStatus; altitude: number | null; onAltitudeChange: (altitude: number | null) => void;
}) {
  const sliderId = useId();
  const [lastAltitude, setLastAltitude] = useState(DEFAULT_TERRAIN_ALTITUDE);
  const [altitudeDraft, setAltitudeDraft] = useState<string | null>(null);
  if (status.state === 'idle') return null;
  const selected = altitude ?? lastAltitude;
  const sliderAltitude = Math.round(selected / TERRAIN_SLIDER_STEP) * TERRAIN_SLIDER_STEP;
  const comparison = altitude !== null;
  const changeAltitude = (next: number) => {
    setLastAltitude(next);
    onAltitudeChange(next);
  };
  const selectMode = (clearance: boolean) => {
    if (altitude !== null) setLastAltitude(altitude);
    onAltitudeChange(clearance ? selected : null);
  };
  const stops = [{ feet: status.interval, color: `rgb(${terrainColor(status.interval).join(', ')})` },
    ...TERRAIN_COLOR_STOPS.filter(stop => stop.feet > status.interval)];
  const position = (feet: number) => (feet - status.interval) / (10000 - status.interval) * 100;
  return <section className="terrain-legend" aria-label="Route terrain elevation"
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <div className="terrain-legend-heading"><strong>Terrain</strong><span>{comparison ? 'Difference in ft' : 'ft MSL'}</span></div>
    {status.state === 'zoom' && <div className="terrain-zoom-hint" role="status">
      <span aria-hidden="true">＋</span><span>Zoom in to see terrain contours</span>
    </div>}
    <div className="terrain-color-modes" role="tablist" aria-label="Terrain coloring" onKeyDown={event => {
      let next: number;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = comparison ? 0 : 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = 1;
      else return;
      event.preventDefault();
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      selectMode(next === 1);
    }}>
      <button type="button" role="tab" id={`${sliderId}-elevation-tab`} aria-controls={`${sliderId}-elevation-panel`}
        aria-selected={!comparison} tabIndex={comparison ? -1 : 0} onClick={() => selectMode(false)}>Elevation</button>
      <button type="button" role="tab" id={`${sliderId}-clearance-tab`} aria-controls={`${sliderId}-clearance-panel`}
        aria-selected={comparison} tabIndex={comparison ? 0 : -1} onClick={() => selectMode(true)}>Clearance</button>
    </div>
    <div className="terrain-legend-panel" role="tabpanel" id={`${sliderId}-elevation-panel`}
      aria-labelledby={`${sliderId}-elevation-tab`} hidden={comparison} tabIndex={0}>
      <span className="terrain-scale" aria-hidden="true" style={{ background: `linear-gradient(to right, ${
        stops.map(stop => `${stop.color} ${position(stop.feet)}%`).join(', ')})` }} />
      <span className="terrain-scale-labels"><span>{status.interval.toLocaleString('en-US')}</span>
        <span style={{ position: 'absolute', left: `${position(5000)}%`, transform: 'translateX(-50%)' }}>5,000</span><span>10,000+</span></span>
      <small>Below {status.interval.toLocaleString('en-US')} ft unshaded</small>
    </div>
    <div className="terrain-legend-panel" role="tabpanel" id={`${sliderId}-clearance-panel`}
      aria-labelledby={`${sliderId}-clearance-tab`} hidden={!comparison}>
      <div className="terrain-altitude-heading">
        <label id={`${sliderId}-label`} htmlFor={`${sliderId}-input`}>Selected altitude</label>
        <span className="terrain-altitude-value">
          <input id={`${sliderId}-input`} className="terrain-altitude-input" type="number" inputMode="numeric"
            min="0" max={MAX_TERRAIN_ALTITUDE} step={TERRAIN_ALTITUDE_STEP} value={altitudeDraft ?? selected}
            onChange={event => setAltitudeDraft(event.currentTarget.value)}
            onBlur={event => {
              const value = event.currentTarget.value.trim();
              setAltitudeDraft(null);
              if (value === '' || !Number.isFinite(Number(value))) return;
              changeAltitude(Math.max(0, Math.min(MAX_TERRAIN_ALTITUDE,
                Math.round(Number(value) / TERRAIN_ALTITUDE_STEP) * TERRAIN_ALTITUDE_STEP)));
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === 'Escape') { event.preventDefault(); setAltitudeDraft(null); }
            }} />
          <span>ft MSL</span>
        </span>
      </div>
      <input id={sliderId} className="terrain-altitude-slider" type="range" min="0" max={MAX_TERRAIN_ALTITUDE}
        aria-labelledby={`${sliderId}-label`}
        step={TERRAIN_SLIDER_STEP} value={sliderAltitude} aria-valuetext={`${sliderAltitude.toLocaleString('en-US')} feet MSL`}
        onChange={event => {
          setAltitudeDraft(null);
          changeAltitude(Number(event.currentTarget.value));
        }} />
      <div className="terrain-altitude-limits"><span>0 ft</span><span>{MAX_TERRAIN_ALTITUDE.toLocaleString('en-US')} ft</span></div>
      <div className="terrain-clearance-key" aria-label="Clearance colors"
        title="Colors compare the selected altitude with the top of each terrain band.">
        {[[CLEARANCE_COLORS.above, '≤ 0'], [CLEARANCE_COLORS.close, '0–500'], [CLEARANCE_COLORS.near, '500–1k'],
          [CLEARANCE_COLORS.below, '1–2k']].map(([color, label]) =>
          <span key={label}><i style={{ background: color }} /><span>{label}</span></span>)}
        <span className="terrain-clearance-unshaded"><i /><span>2k+</span></span>
      </div>
      <small>Selected altitude − terrain · 2k+ unshaded</small>
    </div>
    {status.state !== 'zoom' && <small role="status">{terrainSummary(status)}</small>}
  </section>;
}
