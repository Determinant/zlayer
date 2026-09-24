import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import type { OwnshipLayer, OwnshipSnapshot } from './layer';
import { GPS_MOTION_ACCURACY_METERS } from '../../core/gps/position';
import './styles.css';

export function ownshipSummary({ state, fix }: OwnshipSnapshot): string {
  switch (state) {
    case 'off': return 'Current position, ground track & 1 min track vector';
    case 'acquiring': return 'Waiting for device location…';
    case 'paused': return 'GPS paused while app is hidden';
    case 'denied': return 'Location denied · Allow location in device / site settings';
    case 'unsupported': return 'Device location is unavailable in this browser';
    case 'insecure': return 'Device location requires HTTPS';
    case 'unavailable': return 'GPS unavailable · Waiting for a fix';
    case 'stale': return 'GPS fix stale · Last position only';
    case 'tracking': {
      if (!fix) return 'Waiting for device location…';
      const accuracy = `±${Math.round(fix.accuracy)} m`;
      if (fix.accuracy > GPS_MOTION_ACCURACY_METERS) return `Low accuracy · ${accuracy} · Track unavailable`;
      const track = fix.track === null ? 'Track unavailable' : `${String(Math.round(fix.track) % 360).padStart(3, '0')}°T`;
      const speed = fix.speed === null ? 'GS unavailable' : `${Math.round(fix.speed * 3600 / 1852)} kt`;
      return `${fix.estimated ? 'Est. ' : ''}${track} · ${speed} · ${accuracy}`;
    }
  }
}

export function OwnshipStatus({ layer, enabled, onToggle }: {
  layer: OwnshipLayer; enabled: boolean; onToggle: () => void;
}) {
  const snapshot = useLayerSnapshot(layer);
  const live = enabled && snapshot.state === 'tracking';
  const retry = enabled && ['denied', 'unavailable', 'stale'].includes(snapshot.state);
  return <div className={`ownship-status ${!enabled ? 'is-off' : live ? 'is-live' : ''}`} aria-label="GPS aircraft status">
    <div className="ownship-heading">
      <strong title="Aircraft marks the current GPS position. The blue line shows the 1-minute ground-track trend, curving with turns (up to 90°).">GPS</strong>
      <button type="button" className="ui-switch" role="switch" aria-label="GPS aircraft"
        aria-checked={enabled} onClick={onToggle}>
        <span className="switch" aria-hidden="true"><i /></span>
      </button>
    </div>
    {enabled && <span className="ownship-summary" role="status">{ownshipSummary(snapshot)}</span>}
    {live && <button className="ui-button ui-button--compact" type="button" onClick={layer.center}>Center aircraft</button>}
    {retry && <button className="ui-button ui-button--compact" type="button" onClick={layer.retry}>Retry GPS</button>}
  </div>;
}
