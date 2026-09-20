import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { GeoPointFeature } from '@zlayer/contracts';
import { featureIdent, type RouteDraft, type RouteEntry, type RoutePlan } from '@zlayer/domain';
import { appendRouteFeature, removeRouteEntry } from '../layers/routes/draft';
import { routePointForFeature } from '../layers/routes/selection';
import { removeRoutePoint, routeItemsForPoint } from '../layers/routes/removal';

export type FeatureRoute = {
  plan: RoutePlan;
  pointId?: string | undefined;
  update: (edit: (draft: RouteDraft) => RouteDraft) => void;
};

/** All feature types share the same membership lookup and draft operations. */
export function FeatureRouteActions({ feature, route }: { feature: GeoPointFeature; route: FeatureRoute }) {
  const { plan, pointId, update } = route;
  const ident = featureIdent(feature);
  const point = routePointForFeature(plan, feature, pointId);
  const addLabel = `Add ${ident} to end of route`;
  return <>
    {point && <RouteRemoveButton key={`${plan.revision}:${pointId ?? ''}`} ident={ident}
      items={routeItemsForPoint(plan, point)}
      onRemove={item => update(draft => item ? removeRouteEntry(draft, item.id) : removeRoutePoint(draft, plan, point))} />}
    <button className="append-route-button" type="button" aria-label={addLabel} title={addLabel}
      onClick={() => update(draft => appendRouteFeature(draft, feature))}>
      <RouteActionIcon add />
    </button>
  </>;
}

function RouteRemoveButton({ ident, onRemove, items }: {
  ident: string;
  onRemove: (item?: RouteEntry) => void;
  items: RouteEntry[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const label = `Remove ${ident} from route`;
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); close(); return;
    }
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!open) { setOpen(true); return; }
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return <div className="feature-route-remove" ref={root} onKeyDown={onKeyDown}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button className="remove-route-button" type="button" ref={trigger} aria-label={label} title={label}
      {...(items.length ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': open, 'aria-controls': open ? id : undefined } : {})}
      onClick={() => items.length ? open ? close() : setOpen(true) : onRemove()}>
      <RouteActionIcon />
    </button>
    {open && <div id={id} className="feature-route-remove-menu" ref={menu} role="menu" aria-label={`Remove ${ident}`}>
      <button type="button" role="menuitem" onClick={() => { close(); onRemove(); }}>
        <strong>Remove only {ident}</strong>
        <small>Keep other displayed points as direct waypoints.</small>
      </button>
      {items.map(item => <button key={item.id} type="button" role="menuitem"
        onClick={() => { close(); onRemove(item); }}>Remove entire {item.text} route item</button>)}
    </div>}
  </div>;
}

function RouteActionIcon({ add = false }: { add?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="5" cy="5" r="2" /><path d="M5 7v7a4 4 0 0 0 4 4h2M12 18h10" />
    {add && <path d="M17 13v10" />}
  </svg>;
}
