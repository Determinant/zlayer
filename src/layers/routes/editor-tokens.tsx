import { forwardRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { routePointLabel, type RouteApproach, type RouteTerminal, type RoutePlan, type RouteWaypoint } from '@zlayer/domain';
import { routeTokenStateClass } from './waypoint-style';
import { formatWaypointLabel } from '../../core/format/coordinates';
import type { DragVisual } from './use-editor-gestures';

type RouteEntryProps = {
  value: string;
  placeholder: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
};

export const RouteEntry = forwardRef<HTMLInputElement, RouteEntryProps>(function RouteEntry(
  { value, placeholder, ariaLabel, onChange, onKeyDown, onBlur },
  ref,
) {
  return (
    <input
      ref={ref}
      className="route-entry"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      aria-label={ariaLabel}
      aria-describedby="route-summary route-recommend-hint"
      autoCapitalize="characters"
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
    />
  );
});

type RouteTokenProps = {
  entryId: string;
  ident: string;
  approach: RouteApproach | undefined;
  arrival: RouteTerminal | undefined;
  onChooseArrival: (() => void) | undefined;
  onRemoveArrival: (() => void) | undefined;
  departure: RouteTerminal | undefined;
  onChooseDeparture: (() => void) | undefined;
  onRemoveDeparture: (() => void) | undefined;
  onChooseApproach: (() => void) | undefined;
  onRemoveApproach: (() => void) | undefined;
  waypoint: RouteWaypoint | undefined;
  airway: RoutePlan['airways'][number] | undefined;
  procedure: RoutePlan['procedures'][number] | undefined;
  tec: RoutePlan['tecRoutes'][number] | undefined;
  invalid: boolean;
  pending: boolean;
  drag: DragVisual | undefined;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onOpenMenu: (element: HTMLButtonElement) => void;
};

export function RouteToken({
  entryId,
  ident,
  approach,
  departure,
  arrival,
  onChooseArrival,
  onRemoveArrival,
  onChooseDeparture,
  onRemoveDeparture,
  onChooseApproach,
  onRemoveApproach,
  waypoint,
  airway,
  procedure,
  tec,
  invalid,
  pending,
  drag,
  onPointerDown,
  onClick,
  onOpenMenu,
}: RouteTokenProps) {
  const stateClass = routeTokenStateClass({ waypoint, airway, procedure, tec, invalid, pending });
  const label = formatWaypointLabel(waypoint ? routePointLabel(waypoint) : ident);
  const description = tec ? `${ident} · TEC · ${tec.route.originId} → ${tec.route.destinationId}` : procedure
    ? `${ident} · ${procedure.kind === 'departure' ? 'SID' : 'STAR'} · ${procedure.airport} · ${procedure.transition} transition · waypoint preview`
    : airway ? `${ident} · ${airway.entry} → ${airway.exit}` : ident;
  const unresolved = stateClass === 'is-unresolved';
  const statusDescription = unresolved ? ' · Invalid or unknown route entry' : stateClass === 'is-pending' ? ' · Resolving route entry' : '';
  const isDragging = drag?.sourceId === entryId;
  const dropClass = drag && drag.sourceId !== entryId && drag.targetId === entryId
    ? drag.before ? 'is-drop-before' : 'is-drop-after'
    : '';
  return (
    <li className={`${dropClass}${approach || departure || arrival ? ' route-approach-bundle' : ''}${departure ? ' has-departure' : ''}${approach || arrival ? ' has-approach' : ''}${isDragging ? ' is-entry-dragging' : ''}`}
      style={isDragging ? { transform: `translate3d(${drag.offsetX}px, 0, 0)` } : undefined}
      data-route-entry={entryId}>
      {(approach || departure || arrival) && <span className="route-approach-outline" aria-hidden="true" />}
      {arrival && <>
        <button type="button" className="route-attached-departure route-attached-arrival" title={`${arrival.name} · ${arrival.branchName ?? ''} · ${arrival.transition}`}
          aria-label={`Change STAR for ${ident}: ${arrival.ident}`} disabled={!onChooseArrival}
          onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onChooseArrival?.(); }}>
          <span>{arrival.ident} · {arrival.branchName ?? ''} · {arrival.transition || 'Vectors'}</span>
        </button>
        {onRemoveArrival && <button type="button" className="route-detach-departure" aria-label={`Remove ${arrival.ident} STAR from ${ident}`}
          onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onRemoveArrival(); }}>×</button>}
      </>}
      {approach && <>
        <button type="button" className="route-attached-approach" title={`${approach.name}${approach.entry ? ` · ${approach.entry.name}` : ''}`}
          aria-label={`Change approach for ${ident}: ${approach.name}`} disabled={!onChooseApproach}
          aria-description={approach.entry ? `Entry: ${approach.entry.name}` : 'Choose an approach entry'}
          onClick={event => { event.stopPropagation(); onChooseApproach?.(); }}
          onContextMenu={event => { event.preventDefault(); onOpenMenu(event.currentTarget); }}>
          <svg viewBox="0 0 16 16" aria-hidden="true" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2v3a5 5 0 0 0 5 5h4M10 7l3 3-3 3" /></svg>
          <span>{approach.name.replace(/\b(?:RWY|RUNWAY)\s+/gi, '')}{approach.entry ? ` · ${approach.entry.name}` : ''}</span>
        </button>
        {onRemoveApproach && <button type="button" className="route-detach-approach"
          aria-label={`Remove ${approach.name} approach from ${ident}`} title="Remove approach"
          onClick={event => { event.stopPropagation(); onRemoveApproach(); }}>×</button>}
      </>}
      <button
        type="button"
        className={`route-token ${stateClass}${isDragging ? ' is-dragging' : ''}`}
        onPointerDown={onPointerDown}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenMenu(event.currentTarget);
        }}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            onOpenMenu(event.currentTarget);
          }
        }}
        aria-label={`${description}${statusDescription}. Click or tap for actions; drag to scroll; hold then drag to reorder.`}
        aria-invalid={unresolved || undefined}
        aria-haspopup="menu"
        title={`${description}${statusDescription} · Click or tap for actions · Drag to scroll · Hold to reorder`}
      >
        <strong>{label}</strong>
      </button>
      {departure && <>
        <button type="button" className="route-attached-departure" title={`${departure.name} · ${departure.branchName ?? 'Choose runway/branch'} · ${departure.transition}`}
          aria-label={`Change SID for ${ident}: ${departure.ident}`} disabled={!onChooseDeparture}
          aria-description={`${departure.branchName ?? 'Choose a runway/branch'} · Exit: ${departure.transition}`}
          onClick={event => { event.stopPropagation(); onChooseDeparture?.(); }}
          onContextMenu={event => { event.preventDefault(); onOpenMenu(event.currentTarget); }}>
          <svg viewBox="0 0 16 16" aria-hidden="true" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12h3a5 5 0 0 0 5-5V3M7 6l3-3 3 3" /></svg>
          <span>{departure.ident} · {departure.branchName?.split(' · ')[0] ?? 'Choose branch'} · {departure.transition}</span>
        </button>
        {onRemoveDeparture && <button type="button" className="route-detach-departure"
          aria-label={`Remove ${departure.ident} SID from ${ident}`} title="Remove SID"
          onClick={event => { event.stopPropagation(); onRemoveDeparture(); }}>×</button>}
      </>}
    </li>
  );
}
