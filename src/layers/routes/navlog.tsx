import { Fragment, useEffect, useMemo, useRef } from 'react';
import type { RoutePlan } from '@zlayer/domain';
import { formatWaypointLabel } from '../../core/format/coordinates';
import { useMagneticModel } from '../../core/geo/use-magnetic-model';
import { useBackDismiss } from '../../core/ui/pwa-back';
import { fetchMagneticModel } from '../../workspace/catalog/catalog';
import { navLogRows } from './navlog-rows';
import { routeWaypointClass } from './waypoint-style';
import type { RouteLoadStatus } from './use-plan';
import './navlog.css';

export function RouteNavLog({ id, open, onToggle, plan, status, revision }: {
  id: string; open: boolean; onToggle: () => void; plan: RoutePlan; status: RouteLoadStatus; revision: string;
}) {
  const root = useRef<HTMLDivElement>(null), returnFocus = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const model = useMagneticModel(revision, open, fetchMagneticModel);
  const { rows, incomplete } = useMemo(() => navLogRows(plan, model), [plan, model]);
  const partial = incomplete || status === 'partial' || status === 'error' || status === 'loading';
  const close = () => { onToggle(); returnFocus.current?.focus({ preventScroll: true }); };
  useBackDismiss(open, root, close, 0);
  useEffect(() => {
    if (!open) return;
    // Keep the opener when StrictMode replays this focus effect.
    const active = document.activeElement;
    if (active instanceof HTMLElement && !root.current?.contains(active)) returnFocus.current = active;
    scroll.current?.focus({ preventScroll: true });
  }, [open]);
  return <div ref={root} className={`route-navlog${open ? ' is-open' : ''}`}
    onKeyDown={event => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault(); event.stopPropagation(); close();
    }}>
    <div className="route-navlog-reveal" inert={!open} aria-hidden={!open}>
      <section id={id} className="route-navlog-panel" aria-label="NavLog">
        <div className="route-navlog-heading">
          <strong>NavLog</strong>
          <span role="status">{status === 'loading' ? 'Resolving route…' : rows.length > 0
            ? `${rows.length} ${rows.length === 1 ? 'fix' : 'fixes'} · ${plan.distanceNm.toFixed(1)} NM${partial ? ' known' : ''}` : ''}</span>
        </div>
        <div ref={scroll} className="route-navlog-scroll panel-scroll" tabIndex={0} aria-label="NavLog rows">
          {rows.length > 0 ? <table aria-label="Route navigation log">
            <colgroup><col /><col className="navlog-course-column" /><col className="navlog-distance-column" /><col className="navlog-distance-column" /></colgroup>
            <thead><tr>
              <th scope="col">Waypoint</th>
              <th scope="col" title="Initial course: magnetic / true. A dash means the magnetic reference is unavailable; curved paths vary.">Course <small>M / T</small></th>
              <th scope="col">Leg <small>NM</small></th>
              <th scope="col" title={partial ? 'Cumulative distance of known legs only' : 'Cumulative distance'}>{partial ? 'Known' : 'Total'} <small>NM</small></th>
            </tr></thead>
            <tbody>{rows.map((row, index) => <Fragment key={`${row.waypoint.source.entryId}:${index}`}>
              {row.section && <tr className="route-navlog-section"><td colSpan={4}>{row.section}</td></tr>}
              {row.gap && <tr className="route-navlog-gap"><td colSpan={4}><span aria-hidden="true">⋯</span> {row.gap}</td></tr>}
              <tr className={`route-navlog-row${row.waypoint.approachPhase === 'missed' ? ' is-missed' : ''}`}>
                <th scope="row" title={row.waypoint.ident}>
                  <span className={`route-navlog-waypoint ${routeWaypointClass(row.waypoint)}`}><strong>{formatWaypointLabel(row.waypoint.ident)}</strong>
                    {(row.waypoint.approachHold || row.waypoint.approachRole) && <small>
                      {row.waypoint.approachHold ? `HOLD ${row.waypoint.approachHold.turn === 'unknown' ? '?' : row.waypoint.approachHold.turn}` : row.waypoint.approachRole}
                    </small>}
                  </span>
                </th>
                <td>{row.course}</td>
                <td>{row.distanceNm === null ? '—' : row.distanceNm.toFixed(1)}</td>
                <td>{row.totalNm.toFixed(1)}</td>
              </tr>
            </Fragment>)}</tbody>
          </table> : <p className="route-navlog-empty">{!plan.entries.length ? 'Add waypoints to build a NavLog.'
            : status === 'loading' ? 'Resolving route waypoints…' : 'No resolved waypoints.'}</p>}
          {(status === 'error' || status === 'partial') && <p className="route-navlog-note">Some route data is unavailable. Only known legs are counted.</p>}
          {plan.unresolved.length > 0 && status !== 'loading' && <p className="route-navlog-note" title={plan.issues.map(issue => issue.message).join('\n')}>
            Route issues: {plan.unresolved.join(' · ')}. See route details.
          </p>}
          {(!!plan.approachDepictions?.length || plan.procedures.length > 0) && <p className="route-navlog-note">
            Schematic paths and holds are excluded; only resolved connections are counted.
          </p>}
        </div>
      </section>
      <button type="button" className="route-navlog-bezel" aria-label="Hide NavLog" title="Hide NavLog"
        aria-expanded={open} aria-controls={id} onClick={close}>
        <svg viewBox="0 0 24 16" aria-hidden="true"><path d="M7 3h10m-10 9 5-5 5 5" /></svg>
      </button>
    </div>
  </div>;
}
