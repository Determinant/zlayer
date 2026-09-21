import { memo, useMemo, useState } from 'react';
import type { RoutePlan } from '@zlayer/domain';
import type { AhrsSnapshot } from './layer';
import { HSI_FULL_SCALE_NM, legGuidance, nearestLeg, type HsiLeg } from './navigation';
import { magneticBearing, magneticField, type MagneticModel } from '../../core/geo/magnetic-model';

const degrees = (value: number | null) => value === null ? '—' : `${String(Math.round(value) % 360).padStart(3, '0')}°`;
const nm = (value: number | undefined) => value === undefined ? '—' : value < 100 ? value.toFixed(1) : Math.round(value).toString();

/** Freeze stowed route calculations without losing the selected leg. */
export const Hsi = memo(function Hsi({ state, route, magneticModel }: {
  state: AhrsSnapshot; route?: Pick<RoutePlan, 'legs'> | undefined; active?: boolean;
  magneticModel?: MagneticModel | null | undefined;
}) {
  // The CDI has no procedure sequencing or curved-path model. Never replace an
  // approach/hold/arc with endpoint guidance that cuts across its depicted path.
  const legs = useMemo<HsiLeg[]>(() => (route?.legs ?? []).flatMap((leg, index) =>
    leg.approachPhase || leg.owners.some(owner => owner.kind === 'approach') || (leg.geometry && leg.geometry.length > 2)
      ? [] : [{
        key: JSON.stringify([index, leg.from.ident, leg.to.ident, leg.from.feature.geometry.coordinates, leg.to.feature.geometry.coordinates]),
        from: leg.from.ident, to: leg.to.ident,
        start: leg.from.feature.geometry.coordinates, end: leg.to.feature.geometry.coordinates,
      }]), [route?.legs]);
  const omittedLegs = (route?.legs.length ?? 0) - legs.length;
  const [selection, setSelection] = useState('auto');
  const selected = legs.find(leg => leg.key === selection);
  const inertialLive = state.phase === 'ready' && state.attitude !== null && Number.isFinite(state.attitude.yaw) &&
    ['tracking', 'coasting', 'degraded'].includes(state.attitude.status);
  const headingValid = inertialLive && state.attitude!.headingStatus === 'tracking' &&
    state.attitude!.attitudeStd[2] <= 20 && state.attitude!.status !== 'degraded';
  const heading = headingValid ? state.attitude!.yaw : null;
  const track = state.gpsLive && (state.speed ?? 0) >= 1 && Number.isFinite(state.track) ? state.track : null;
  // GPS course is a separate geographic marker, never the rotating card's source.
  // Keep live AHRS yaw while north alignment is uncertain, explicitly marked REL.
  const reference = inertialLive ? state.attitude!.yaw : null;
  const guidance = useMemo(() => state.gpsLive && state.position
    ? selected ? legGuidance(selected, state.position) : nearestLeg(legs, state.position, track) : null,
  [state.gpsLive, state.position, selected, legs, track]);
  const relative = heading === null && inertialLive;
  const referenceName = relative ? 'REL' : 'HDG';
  // Variation changes slowly: evaluate once per fix/height/day, not at IMU cadence.
  const longitude = state.position?.[0], latitude = state.position?.[1];
  const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const field = useMemo(() => magneticModel && longitude !== undefined && latitude !== undefined
    ? magneticField(magneticModel, [longitude, latitude], state.altitude, day) : null,
  [magneticModel, longitude, latitude, state.altitude, day]);
  // Use TRUE in both NOAA caution/blackout zones and at the geographic poles.
  const declination = field && field.horizontal >= 6000 && Math.abs(latitude!) < 90 ? field.declination : null;
  const magnetic = heading !== null && declination !== null;
  // The empty instrument defaults to magnetic heading; TRUE requires an actual reading.
  const trueReference = !magnetic && heading !== null;
  const suffix = trueReference ? 'T' : 'M', referenceLabel = trueReference ? 'true' : 'magnetic';
  const bearing = (value: number | null) => value === null ? null : magneticBearing(value, magnetic ? declination! : 0);
  const variationNote = relative ? 'Relative direction · heading unverified'
    : magnetic ? `VAR ${Math.abs(declination!).toFixed(1)}° ${declination! >= 0 ? 'E' : 'W'}`
    : magneticModel && day >= Date.parse(magneticModel.validUntil) ? 'Magnetic model expired'
    : field && (field.horizontal < 6000 || Math.abs(latitude!) === 90) ? 'Magnetic reference weak'
    : 'Magnetic variation unavailable';
  const warning = !state.gpsLive || !state.position ? 'No GPS' : !state.gpsUsable ? 'Low Speed'
    : !inertialLive ? state.phase === 'ready' ? 'Motion' : 'Calibration' : heading === null ? 'Heading'
    : !legs.length && !omittedLegs ? 'No route' : !guidance ? 'No usable leg' : '';
  // A geographic course cannot be oriented against unaligned relative yaw.
  const available = guidance !== null && heading !== null;
  const card = bearing(reference) ?? 0;
  const trueCard = reference ?? 0;
  const courseRotation = guidance ? guidance.course - trueCard : 0;
  const side = guidance && Math.abs(guidance.crossTrackNm) >= .005 ? guidance.crossTrackNm > 0 ? 'R' : 'L' : '';
  const direction = relative ? `Relative direction ${degrees(reference)}. Heading unverified.`
    : reference !== null ? `Heading ${degrees(bearing(reference))} ${referenceLabel}.` : '';
  const description = available
    ? `${warning ? `${warning}. ` : ''}${direction} Course ${degrees(bearing(guidance.course))} ${referenceLabel}, ${guidance.leg.from} to ${guidance.leg.to}. ${nm(guidance.distanceNm)} nautical miles to waypoint. ${side ? `${Math.abs(guidance.crossTrackNm).toFixed(2)} nautical miles ${side === 'R' ? 'right' : 'left'} of course.` : 'On course.'}${heading !== null ? ` True heading ${degrees(heading)}.` : ''}${heading !== null && track !== null ? ` GPS track ${degrees(bearing(track))} ${referenceLabel}.` : ''}`
    : `${warning}.${direction ? ` ${direction}` : ''}`;
  return <section className="ahrs-hsi" aria-label="Horizontal situation indicator">
    <div className="ahrs-hsi-heading"><strong>HSI</strong><span>{relative ? 'IMU · REL'
      : `IMU · ${trueReference ? 'TRUE' : 'MAG'}`}</span></div>
    <div className={`ahrs-hsi-readout${heading !== null || relative ? ' ahrs-hsi-heading-value' : ''}`}>
      {referenceName} {degrees(bearing(reference))}{!relative && ` ${suffix}`}
    </div>
    <svg viewBox="90 18 140 146" className="ahrs-hsi-dial" role="img" aria-label={`HSI. ${description}`}>
      <circle cx="160" cy="94" r="67" fill="#0a1520" stroke="#39505f" />
      <g transform={`translate(160 94) rotate(${-card})`} data-testid="hsi-compass">
        {Array.from({ length: 72 }, (_, i) => i * 5).map(angle => <g key={angle} transform={`rotate(${angle})`}>
          <path d={`M0 -64v${angle % 30 === 0 ? 10 : angle % 10 === 0 ? 6 : 3}`} stroke="#92a7b7" />
          {angle % 30 === 0 && <text x="0" y="-45" textAnchor="middle" transform={`rotate(${card - angle} 0 -49)`}>
            {!relative && angle % 90 === 0 ? ['N', 'E', 'S', 'W'][angle / 90] : angle / 10}
          </text>}
        </g>)}
      </g>
      <path d="M160 20v7" stroke="#dcecf2" strokeWidth="1.5" />
      {(heading !== null || relative) && <g transform="translate(160 94) rotate(0)"
        data-testid={relative ? 'hsi-relative-heading' : 'hsi-heading'}>
        <title>{relative ? `Relative direction ${degrees(reference)} — heading unverified` : `True heading ${degrees(heading)} T`}</title>
        <path d="m-5 -73 5 8 5-8Z" fill="#ffdb80" stroke="#0a1520" strokeWidth=".8" />
      </g>}
      {track !== null && heading !== null && <path d="m0 -68 4 5-4 5-4-5Z" fill="#dcecf2"
        transform={`translate(160 94) rotate(${track - trueCard})`} data-testid="hsi-track" />}
      {available && <g className="ahrs-hsi-course" transform={`translate(160 94) rotate(${courseRotation})`} data-testid="hsi-course">
        <path d="M0 -56V-24M0 24V63" stroke="currentColor" strokeWidth="1.8" />
        <path d="m0 -64-4 8h8Z" fill="currentColor" />
        {[-2, -1, 1, 2].map(dot => <circle key={dot} cx={dot * 14} cy="0" r="2" fill="none" stroke="#a0acb9" strokeWidth=".8" />)}
        <path d="M0 -24V24" stroke="currentColor" strokeWidth="2" transform={`translate(${guidance.deviation * 28} 0)`}
          data-testid="hsi-deviation" />
        <path d={guidance.from ? 'm0 31-3-6h6Z' : 'm0 -31-3 6h6Z'} fill="currentColor" />
      </g>}
      <path d="M160 80v28m-13-10 13-6 13 6m-18 8 5-2 5 2" fill="none" stroke="#091521" strokeWidth="5" strokeLinejoin="round" />
      <path d="M160 80v28m-13-10 13-6 13 6m-18 8 5-2 5 2" fill="none" stroke="#e5edf1" strokeWidth="1.5" strokeLinejoin="round" />
      {warning && !available && <g data-testid="hsi-invalid" aria-hidden="true">
        <path d="M113 47 207 141M207 47 113 141" stroke="#ff7074" strokeWidth="2.5" strokeOpacity="0.8" />
        <rect x="108" y="84" width="104" height="20" rx="3" fill="#341c24ee" />
        <text x="160" y="98" textAnchor="middle" className="ahrs-hsi-warning">{warning}</text>
      </g>}
    </svg>
    {heading !== null && <div className="ahrs-hsi-reference">
      <span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m6 1 4 5-4 5-4-5Z" fill="currentColor" /></svg>
        TRK {degrees(bearing(track))} {suffix}
      </span>
    </div>}
    <div className={`ahrs-hsi-variation${magnetic ? '' : ' is-unavailable'}`}>
      {warning && available && <span className="ahrs-hsi-caution" data-testid="hsi-caution">{warning}</span>}
      {magnetic && heading !== null && <span className="ahrs-hsi-heading-value">TRUE HDG {degrees(heading)} T</span>}
      <span>{variationNote}{trueReference && ' · using TRUE'}</span>
    </div>
    <dl className="ahrs-hsi-readings">
      <div><dt>{relative ? 'DTK' : `DTK · ${suffix}`}</dt><dd className="ahrs-hsi-course">{available ? degrees(bearing(guidance.course)) : '—'}</dd></div>
      <div><dt>DIST · NM</dt><dd>{available ? nm(guidance.distanceNm) : '—'}</dd></div>
      <div><dt>XTK · NM</dt><dd className="ahrs-hsi-course">{available ? `${Math.abs(guidance.crossTrackNm).toFixed(2)} ${side}` : '—'}</dd></div>
      <div><dt>CDI SCALE</dt><dd>±{HSI_FULL_SCALE_NM} NM</dd></div>
    </dl>
    <div className="ahrs-hsi-target ahrs-hsi-course">
      {available ? `${guidance.from ? 'FROM' : 'TO'} ${guidance.leg.to}` : 'ROUTE GUIDANCE UNAVAILABLE'}
    </div>
    {omittedLegs > 0 && <p className="ahrs-hsi-empty">Approach and curved legs are shown on the map. HSI guidance covers straight route legs only.</p>}
    {legs.length > 0 ? <label className="ahrs-hsi-leg"><span>Route leg</span>
      <select aria-label="HSI route leg" value={selected?.key ?? 'auto'} onChange={event => setSelection(event.target.value)}>
        <option value="auto">Auto · nearest{guidance ? ` · ${guidance.leg.from} → ${guidance.leg.to}` : ''}</option>
        {legs.map((leg, i) => <option key={leg.key} value={leg.key}>{i + 1}. {leg.from} → {leg.to}</option>)}
      </select>
    </label> : <div className="ahrs-hsi-empty">{omittedLegs ? 'No supported route legs.' : 'Add a route to show its magenta course.'}</div>}
  </section>;
}, (previous, next) => next.active === false ||
  (previous.active === next.active && previous.state === next.state && previous.route === next.route &&
    previous.magneticModel === next.magneticModel));
