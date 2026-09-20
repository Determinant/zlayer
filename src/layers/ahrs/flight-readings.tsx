import { useId } from 'react';
import { mechanicalColumns, MPH_PER_KNOT, type InstrumentValues } from './instrument-display';
import { VerticalSpeedReadout } from './vertical-speed-indicator';

/** Beveled tape readout: higher digits occupy one row; the lowest drum exposes
 * neighboring knots or the altimeter's 00/20/40/60/80 bundle. */
export function DrumNumber({ value, step, minimumDigits, label, unit, compact = false }: {
  value: number | null; step: 1 | 20; minimumDigits: number; label: string; unit: string; compact?: boolean;
}) {
  const id = useId();
  const available = value !== null && Number.isFinite(value);
  const inRange = available && Math.abs(value) < 1_000_000;
  const columns = inRange ? mechanicalColumns(value, step, minimumDigits) : [];
  const negative = inRange && value < 0;
  const slots = columns.reduce((total, column) => total + column.digits, negative ? 1 : 0);
  const width = compact ? step === 20 ? 74 : 68 : 132, height = compact ? 72 : 80;
  const left = compact && step === 20 ? 8 : 2;
  const edge = compact && step === 1 ? width - 8 : width - 2;
  const size = Math.min(compact ? step === 20 ? 18 : 22 : step === 20 ? 25 : 27,
    (edge - left - 6) / (Math.max(1, slots) * .68));
  // Leave a little bearing space around B612 digits, including at fractional
  // SVG scales on narrow displays; a tight advance-width clip can shave ink.
  const digitWidth = size * .68, rowHeight = size * 1.15;
  const center = height / 2, narrowHeight = size * 1.45;
  const wideHeight = Math.min(height - 8, rowHeight * 2.45);
  const top = center - narrowHeight / 2, bottom = center + narrowHeight / 2;
  const wideTop = center - wideHeight / 2, wideBottom = center + wideHeight / 2;
  let right = edge - 3;
  const lowLeft = right - (step === 20 ? 2 : 1) * digitWidth - 3;
  // The pointer belongs to the readout bezel, so it stays visible at the exact
  // value index instead of being covered by the rolling digit window.
  const rightEdge = compact && step === 1
    ? `V${center - 6}L${width - 1} ${center}L${edge} ${center + 6}` : '';
  const leftEdge = compact && step === 20
    ? `V${center + 6}L1 ${center}L${left} ${center - 6}` : '';
  const aperture = `M${left + 2} ${top}H${lowLeft - 2}L${lowLeft} ${top - 2}
    V${wideTop + 2}L${lowLeft + 2} ${wideTop}H${edge - 2}L${edge} ${wideTop + 2}
    ${rightEdge}V${wideBottom - 2}L${edge - 2} ${wideBottom}H${lowLeft + 2}L${lowLeft} ${wideBottom - 2}
    V${bottom + 2}L${lowLeft - 2} ${bottom}H${left + 2}L${left} ${bottom - 2}
    ${leftEdge}V${top + 2}Z`;
  const description = !available ? 'unavailable' : !inRange ? 'out of range' : `${Math.round(value)} ${unit}`;
  return <svg className={`ahrs-drum${compact ? ' is-compact' : ''}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${description}`}>
    <defs>
      <clipPath id={`${id}-window`}><path d={aperture} /></clipPath>
      <linearGradient id={`${id}-shade`} gradientUnits="userSpaceOnUse" x1="0" y1={wideTop} x2="0" y2={wideBottom}>
        <stop offset="0" stopColor="#070f16" stopOpacity=".9" />
        <stop offset=".35" stopColor="#070f16" stopOpacity="0" />
        <stop offset=".65" stopColor="#070f16" stopOpacity="0" />
        <stop offset="1" stopColor="#070f16" stopOpacity=".9" />
      </linearGradient>
    </defs>
    <path d={aperture} fill="#070f16" />
    <g clipPath={`url(#${id}-window)`}>
      {!inRange ? <text x={width / 2} y={center} textAnchor="middle" dominantBaseline="central" fontSize={available ? 12 : 24}>
        {available ? 'RANGE' : '—'}
      </text> : <>
        {columns.map((column, index) => {
          const span = column.digits * digitWidth, x = right;
          right -= span;
          const windowHeight = index === 0 ? wideHeight : rowHeight;
          // Small SVG font advances differ between browser versions. Fit the
          // whole glyph run inside its slot, keeping a bearing at both edges.
          const glyphWidth = span - .5;
          return <g key={index}>
            <defs><clipPath id={`${id}-${index}`}><rect x={x - span} y={center - windowHeight / 2} width={span} height={windowHeight} /></clipPath></defs>
            <g clipPath={`url(#${id}-${index})`}>
              <g transform={`translate(0 ${column.phase * rowHeight})`} textAnchor="end" dominantBaseline="central" fontSize={size}>
                <text x={x - .25} y={center + rowHeight} textLength={glyphWidth} lengthAdjust="spacingAndGlyphs">{column.previous}</text>
                <text x={x - .25} y={center} textLength={glyphWidth} lengthAdjust="spacingAndGlyphs">{column.current}</text>
                <text x={x - .25} y={center - rowHeight} textLength={glyphWidth} lengthAdjust="spacingAndGlyphs">{column.next}</text>
                {column.nextNext !== undefined && <text x={x - .25} y={center - 2 * rowHeight}
                  textLength={glyphWidth} lengthAdjust="spacingAndGlyphs">{column.nextNext}</text>}
              </g>
            </g>
          </g>;
        })}
        {negative && <text x={right - .25} y={center} textAnchor="end" dominantBaseline="central" fontSize={size}
          textLength={digitWidth - .5} lengthAdjust="spacingAndGlyphs">−</text>}
      </>}
      <rect width={width} height={height} fill={`url(#${id}-shade)`} />
    </g>
    <path d={aperture} fill="none" stroke="#c6d7df" strokeWidth="1" strokeLinejoin="round" />
  </svg>;
}

/** Fixed index, moving scale. Uses the same animated value as its drum. */
function InstrumentTape({ value, altitude = false }: { value: number | null; altitude?: boolean }) {
  const id = useId();
  const width = altitude ? 74 : 68, step = altitude ? 100 : 5;
  const spacing = altitude ? .4 : 3.2;
  const available = value !== null && Number.isFinite(value) && Math.abs(value) < 1_000_000;
  const base = available ? Math.floor(value / step) * step : 0;
  return <svg className="ahrs-tape" viewBox={`0 0 ${width} 248`} aria-hidden="true">
    <defs><clipPath id={`${id}-scale`}><rect x="1" y="34" width={width - 2} height="188" /></clipPath></defs>
    <g clipPath={`url(#${id}-scale)`}>
      {available && Array.from({ length: 17 }, (_, index) => base + (index - 8) * step)
        .filter(mark => altitude || mark >= 0).map(mark => {
          const y = 128 + (value - mark) * spacing;
          // Keep whole labels clear of the bezel; GS labels sit beside the
          // tall drum, while altitude labels extend underneath it.
          if (Math.abs(y - 128) < (altitude ? 33 : 25)) return null;
          const major = altitude || mark % 10 === 0;
          return <g key={mark} transform={`translate(0 ${y})`}>
            <path d={altitude ? `M1 0h${major ? 9 : 5}` : `M${width - 1} 0h${major ? -9 : -5}`} stroke="#afc2cd" />
            {major && <text x={altitude ? width - 5 : 5} y="4" textAnchor={altitude ? 'end' : 'start'}>{mark}</text>}
          </g>;
        })}
    </g>
  </svg>;
}

export function FlightReadings({ values }: { values: InstrumentValues }) {
  return <div className="ahrs-flight-readings">
    <div className="ahrs-flight-reading ahrs-speed-tape">
      <InstrumentTape value={values.groundspeedKnots} />
      <span className="ahrs-flight-label">GS<span>KT</span></span>
      <DrumNumber value={values.groundspeedKnots} step={1} minimumDigits={3} label="Ground speed" unit="knots" compact />
      <small className="ahrs-speed-mph">{values.groundspeedKnots === null ? '—' : Math.round(values.groundspeedKnots * MPH_PER_KNOT)} mph</small>
    </div>
    <div className="ahrs-flight-reading ahrs-altitude-tape">
      <InstrumentTape value={values.altitudeFeet} altitude />
      <span className="ahrs-flight-label">GPS ALT<span>FT</span></span>
      <DrumNumber value={values.altitudeFeet} step={20} minimumDigits={5} label="GPS altitude" unit="feet" compact />
      <VerticalSpeedReadout value={values.verticalSpeed} />
    </div>
  </div>;
}
