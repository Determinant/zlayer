import { formatDate } from '../../core/format/time';
import type { ObstructionStatus } from './types';
import './styles.css';

function summary(status: ObstructionStatus): string {
  if (status.state === 'idle' || status.state === 'zoom') return 'Zoom in or add a route to see obstructions';
  if (status.state === 'loading') return 'Loading FAA obstructions…';
  if (status.state === 'error') return 'Obstructions unavailable · toggle to retry';
  return `${(status.count ?? 0).toLocaleString()} in view`
    + (status.minHeightAglFt === undefined ? '' : ` · ≥${status.minHeightAglFt.toLocaleString()} ft AGL`)
    + (status.routeContext && status.minHeightAglFt !== 500
      ? `${status.minHeightAglFt === undefined ? ' · ' : ' + '}≥500 ft AGL near route` : '');
}

export function ObstructionControls({ enabled, status, onToggle }: {
  enabled: boolean; status: ObstructionStatus; onToggle: () => void;
}) {
  return <section className="layer-section obstruction-section">
    <div className="section-title"><h3>Obstructions</h3><span>FAA Daily DOF</span></div>
    <div className="toggle-list">
      <button type="button" role="switch" aria-checked={enabled} className={enabled ? 'is-active' : ''} onClick={onToggle}>
        <svg className="obstruction-swatch" viewBox="0 0 28 28" aria-hidden="true">
          <path d="M7 23 14 7 21 23M14 2v2M5 7l3 2M23 7l-3 2" /><circle cx="14" cy="23" r="1.2" />
        </svg>
        <span className="layer-copy"><strong>Obstructions</strong><small>{enabled ? summary(status) : 'Off'}</small></span>
        <span className="switch" aria-hidden="true"><i /></span>
      </button>
    </div>
    {enabled && <p className="obstruction-key">Taller structures appear farther out. Routes also show ≥500 ft AGL with a 4 NM core / 8 NM fade.
      {' '}Elevation MSL · (height AGL), feet. UC: unverified.
      {status.sourceDate && <> Source {formatDate(Date.parse(status.sourceDate))}.</>}</p>}
  </section>;
}
