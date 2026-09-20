import { useId } from 'react';
import type { AhrsSnapshot } from './layer';

/** GPS and uncertainty warnings preserve live attitude; calibration faults hide the indication. */
export function Horizon({ attitude, crossed, warning }: Pick<AhrsSnapshot, 'attitude' | 'crossed' | 'warning'>) {
  const id = useId();
  const roll = Number.isFinite(attitude?.roll) ? attitude!.roll : 0;
  const pitch = Number.isFinite(attitude?.pitch) ? Math.max(-85, Math.min(85, attitude!.pitch)) : 0;
  const indicated = warning !== 'Calibration' && attitude !== null;
  return <svg className="ahrs-horizon" viewBox="0 0 320 248" role="img"
    aria-label={`Attitude indicator${crossed ? ` — ${warning}` : ''}. ${indicated ? `Roll ${roll.toFixed(1)}°, pitch ${pitch.toFixed(1)}°.` : 'Awaiting calibration.'}`}>
    <defs>
      <clipPath id={`${id}-clip`}><rect x="1" y="1" width="318" height="246" rx="10" /></clipPath>
      <linearGradient id={`${id}-sky`} x2="0" y2="1"><stop stopColor="#183d59" /><stop offset="1" stopColor="#397c9e" /></linearGradient>
      <linearGradient id={`${id}-ground`} x2="0" y2="1"><stop stopColor="#886447" /><stop offset="1" stopColor="#3d302a" /></linearGradient>
    </defs>
    <g clipPath={`url(#${id}-clip)`}>
      <rect width="320" height="248" fill="#0a1520" />
      {indicated && <g>
        <g transform={`translate(160 128) rotate(${-roll}) translate(0 ${pitch * 3})`} data-testid="ahrs-moving-horizon">
          <rect x="-700" y="-900" width="1400" height="900" fill={`url(#${id}-sky)`} />
          <rect x="-700" y="0" width="1400" height="900" fill={`url(#${id}-ground)`} />
          <path d="M-700 0H700" stroke="#f4efdc" strokeWidth="2" data-testid="ahrs-horizon-line" />
          {Array.from({ length: 33 }, (_, i) => (i - 16) * 5).filter(value => value !== 0).map(value => {
            const width = value % 10 === 0 ? 33 : 16;
            return <g key={value} transform={`translate(0 ${-value * 3})`}>
              <path d={`M${-width} 0H${width}`} stroke="#faf9e9" strokeWidth="1.4" />
              {value % 10 === 0 && <><text x={-width - 7} y="4" textAnchor="end">{Math.abs(value)}</text>
                <text x={width + 7} y="4">{Math.abs(value)}</text></>}
            </g>;
          })}
        </g>
        {/* As in loupe-flightdeck, the bank scale follows the horizon and the
            gold pointer stays with the aircraft. Uniform scaling preserves
            angles and keeps the circular scale between the GS/ALT tapes. */}
        <g transform="translate(160 128) scale(.8)" fill="none" stroke="#fbf7e4" strokeWidth="1.6">
          <g transform={`rotate(${-roll})`} data-testid="ahrs-bank-scale">
            {[-60, -45, -30, -20, -10, 10, 20, 30, 45, 60].map(degrees =>
              <path key={degrees} transform={`rotate(${degrees})`} d={`M0 -105v${degrees % 30 === 0 ? 13 : 7}`} />)}
            <path d="m-5 -105 5 13 5-13Z" data-testid="ahrs-bank-index" />
          </g>
          <path d="m0 -91 -5 8h10Z" fill="#ffdb80" stroke="#ffdb80" data-testid="ahrs-bank-pointer" />
        </g>
        {/* Fixed jet-style wings: their upper edges are the zero-pitch datum.
            The open center leaves the pitch ladder visible around the square. */}
        <path d="M88 128H137V140H131V133H88ZM232 128H183V140H189V133H232Z"
          fill="#091521" stroke="#091521" strokeWidth="5" strokeLinejoin="miter" />
        <path d="M88 128H137V140H131V133H88ZM232 128H183V140H189V133H232Z"
          fill="#091521" stroke="#ffdb80" strokeWidth="2" strokeLinejoin="miter" data-testid="ahrs-aircraft-reference" />
        <rect x="157" y="125" width="6" height="6" fill="#091521" stroke="#091521" strokeWidth="5" />
        <rect x="157" y="125" width="6" height="6" fill="#091521" stroke="#ffdb80" strokeWidth="2" />
      </g>}
      {crossed && <g className="ahrs-cross" data-testid="ahrs-cross" aria-hidden="true">
        <path d="M18 18 302 230M302 18 18 230" fill="none" stroke="#37191e" strokeOpacity="0.55" strokeWidth="7" />
        <path d="M18 18 302 230M302 18 18 230" fill="none" stroke="#ff7074" strokeOpacity="0.85" strokeWidth="3" />
        <rect x="86" y="111" width="148" height="26" rx="4" fill="#341c24ee" stroke="#ff7074" strokeOpacity="0.7" />
        <text x="160" y="129" textAnchor="middle" className="ahrs-cross-label">{warning}</text>
      </g>}
    </g>
    <rect x="1" y="1" width="318" height="246" rx="10" fill="none" stroke="#748d9c" strokeOpacity="0.35" />
  </svg>;
}
