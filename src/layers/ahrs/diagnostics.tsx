import { memo, useEffect, useState } from 'react';
import type { AhrsLayer, AhrsSnapshot } from './layer';

type Sample = { time: number; tilt: number | null; aided: boolean; breakBefore: boolean };
const HISTORY_SECONDS = 120;

const degrees = (value: number) => Number.isFinite(value) ? `${value.toFixed(2)}°` : '—';
const propagating = (state: AhrsSnapshot) => state.attitude !== null &&
  ['tracking', 'coasting', 'degraded'].includes(state.attitude.status);
const aided = (state: AhrsSnapshot) => state.attitude?.gpsAiding === true || state.attitude?.tiltAiding === true ||
  state.attitude?.magneticFusion.active === true && state.attitude.magneticFusion.mode === 'vector';

function aidingStatus(state: AhrsSnapshot): string {
  if (!propagating(state)) return 'Motion paused';
  if (state.attitude?.tiltAiding) return 'Gravity / acceleration aiding';
  if (state.attitude?.magneticFusion.active) return state.attitude.magneticFusion.mode === 'vector'
    ? 'Magnetic vector aiding' : 'Magnetic heading aiding';
  if (!state.gpsLive) return 'No GPS aid · No GPS';
  if (aided(state)) return 'GPS aiding';
  if (!state.gpsUsable) return 'Waiting for usable sensor observations';
  if (state.attitude?.headingStatus !== 'tracking') return 'Waiting for gravity, magnetic or heading evidence';
  return 'Waiting for GPS correction';
}

function UncertaintyTrend({ samples }: { samples: readonly Sample[] }) {
  const latest = samples.at(-1);
  if (!latest) return null;
  const maximum = Math.max(5, Math.ceil(Math.max(...samples.map(sample => sample.tilt ?? 0)) / 5) * 5);
  const x = (time: number) => 30 + 244 * (1 - (latest.time - time) / HISTORY_SECONDS);
  const y = (tilt: number) => 66 - 56 * tilt / maximum;
  let aidedPath = '', unaidedPath = '';
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1]!, current = samples[i]!;
    // Leave gaps while hidden or without motion; frozen covariance is not a live estimate.
    if (current.breakBefore || previous.tilt === null || current.tilt === null || current.time - previous.time > 2.5) continue;
    const segment = `M${x(previous.time)} ${y(previous.tilt)}L${x(current.time)} ${y(current.tilt)}`;
    if (previous.aided && current.aided) aidedPath += segment;
    else unaidedPath += segment;
  }
  return <svg className="ahrs-uncertainty-trend" viewBox="0 0 280 88" role="img"
    aria-label="Estimated tilt uncertainty over the last two minutes">
    <path className="ahrs-uncertainty-grid" d="M30 10H274M30 66H274" />
    <text x="0" y="14">{maximum}°</text><text x="0" y="70">0°</text>
    <path className="is-aided" d={aidedPath} /><path className="is-unaided" d={unaidedPath} />
    {latest.tilt !== null && <circle className={latest.aided ? 'is-aided' : 'is-unaided'}
      cx={x(latest.time)} cy={y(latest.tilt)} r="2.5" />}
    <text x="30" y="85">2m ago</text><text x="274" y="85" textAnchor="end">now</text>
  </svg>;
}

/** Live covariance diagnostics; the instrument animation demo has no estimator to diagnose. */
export const AhrsDiagnostics = memo(function AhrsDiagnostics({ layer, active }: {
  layer: Pick<AhrsLayer, 'getSnapshot' | 'readDisplaySnapshot'>; active: boolean;
}) {
  const [{ state, samples }, setReading] = useState(() => ({
    state: layer.getSnapshot(), samples: [] as Sample[],
  }));
  useEffect(() => {
    if (!active) return;
    let first = true;
    const sample = () => {
      const state = layer.readDisplaySnapshot(), time = performance.now() / 1000;
      const tilt = propagating(state) && Number.isFinite(state.attitude?.tiltStd) ? state.attitude!.tiltStd : null;
      const point = { time, tilt, aided: aided(state), breakBefore: first };
      first = false;
      setReading(previous => {
        const history = previous.samples.filter(point => point.time >= time - HISTORY_SECONDS);
        // Reopening within one second replaces the last point instead of oversampling.
        if (history.length && time - history.at(-1)!.time < 1) history.pop();
        return { state, samples: [...history.slice(-HISTORY_SECONDS), point] };
      });
    };
    sample();
    const timer = setInterval(sample, 1000);
    return () => clearInterval(timer);
  }, [layer, active]);
  const attitude = state.attitude;
  if (!attitude) return null;
  const live = propagating(state);
  const angle = (value: number) => live ? degrees(value) : '—';
  return <details className="ahrs-diagnostics">
    <summary><span>Tilt uncertainty</span><strong title="Estimated tilt uncertainty (1σ)">{angle(attitude.tiltStd)}</strong></summary>
    <p className={`ahrs-aiding-status${aided(state) ? ' is-aided' : ''}`}>{aidingStatus(state)}</p>
    <UncertaintyTrend samples={samples} />
    <div className="ahrs-uncertainty-legend"><span className="is-aided">Tilt aided</span><span className="is-unaided">Gyro propagation</span></div>
    <dl className="ahrs-diagnostic-readings">
      <div><dt>Roll σ</dt><dd>{angle(attitude.attitudeStd[0])}</dd></div>
      <div><dt>Pitch σ</dt><dd>{angle(attitude.attitudeStd[1])}</dd></div>
      <div><dt>Local yaw σ</dt><dd>{angle(attitude.relativeYawStd)}</dd></div>
      <div><dt>Heading σ</dt><dd>{attitude.headingStatus !== 'tracking' ? 'Unknown' : angle(attitude.attitudeStd[2])}</dd></div>
      <div><dt>Heading</dt><dd title={attitude.headingReason}>{attitude.headingStatus === 'tracking' ? 'Aligned' : attitude.headingStatus === 'recovering' ? 'Recovering' : 'Aligning'}</dd></div>
      <div><dt>Last alignment</dt><dd>{attitude.headingReference === 'relative' ? 'None' : attitude.headingReference === 'manual-true' ? 'Initial input' : 'GPS + IMU'}</dd></div>
      <div><dt>Last velocity aid</dt><dd>{Number.isFinite(attitude.fusionAge) ? `${attitude.fusionAge.toFixed(1)}s ago` : 'Never'}</dd></div>
      <div><dt>Last tilt aid</dt><dd>{Number.isFinite(attitude.tiltFusion.age) ? `${attitude.tiltFusion.age.toFixed(1)}s ago` : 'Never'}</dd></div>
      <div><dt>Magnetic aiding</dt><dd title={attitude.magneticFusion.reason}>{attitude.magneticFusion.active ? 'Active' : 'Waiting'}</dd></div>
    </dl>
    <p className="ahrs-fusion-counts">GPS velocity: {attitude.fusion.accepted} used · {attitude.fusion.rejected} rejected · {attitude.fusion.stale} late</p>
    <p className="ahrs-tilt-counts">Tilt updates: {attitude.tiltFusion.accepted} used · {attitude.tiltFusion.rejected} rejected. {attitude.tiltFusion.reason}</p>
    <p className="ahrs-magnetic-counts">Magnetic fusion: {attitude.magneticFusion.accepted} used · {attitude.magneticFusion.rejected} rejected. {attitude.magneticFusion.reason}</p>
    <p className="ahrs-uncertainty-note">Model estimates (1σ), not measured error. Summary and trend show tilt uncertainty. Mounting/zero-reference error is excluded.</p>
  </details>;
});
