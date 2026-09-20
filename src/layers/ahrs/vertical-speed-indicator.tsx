import type { VerticalSpeedReading } from './vertical-speed';

/** Damped, signed GPS vertical speed below the altitude drum. */
export function VerticalSpeedReadout({ value }: { value: VerticalSpeedReading | null }) {
  const number = value?.roundedFeetPerMinute ?? null;
  const text = number === null ? '—' : number > 0 ? `+${number}` : number < 0 ? `−${Math.abs(number)}` : '0';
  return <svg className="ahrs-vsi-readout" viewBox="0 0 74 34" role="img"
    aria-label={`GPS vertical speed: ${number === null ? 'unavailable' : `${number} feet per minute`}`}>
    <title>GPS altitude trend · vertical speed in feet per minute</title>
    <rect width="74" height="34" fill="#0c1925" />
    <text x="37" y="11" textAnchor="middle" className="ahrs-vsi-label">GPS V/S</text>
    <text x="37" y="28" textAnchor="middle" className="ahrs-vsi-number"
      style={{ fontSize: Math.min(14, 48 / (text.length * .68)) }}>
      <tspan data-testid="ahrs-vsi-number">{text}</tspan><tspan className="ahrs-vsi-unit"> FPM</tspan>
    </text>
  </svg>;
}
