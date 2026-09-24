import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useBackDismiss } from '../core/ui/pwa-back';
import { formatWaypointLabel } from '../core/format/coordinates';
import type { NearbyFeature, SelectFeature } from './feature-selection';
import type { MapContextAction } from '../core/map/selection';
import { featureIdent, featureKey, featureSubtitle, normalizeNavaidType } from '@zlayer/domain';
import './nearby-feature-picker.css';

export function NearbyFeaturePicker({ features, point, actions = [], onSelect, onClose }: {
  features: NearbyFeature[];
  actions?: MapContextAction[];
  point: { x: number; y: number };
  onSelect: SelectFeature;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useBackDismiss(true, ref, onClose);
  const previousFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(true);
  const pressed = useRef<HTMLButtonElement | null>(null);
  const menu = actions.length > 0;
  const [position, setPosition] = useState(point);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLButtonElement>('.nearby-feature-picker-list button')?.focus({ preventScroll: true });
    return () => {
      if (restoreFocus.current && previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    const picker = ref.current;
    const map = picker?.offsetParent;
    if (!picker || !(map instanceof HTMLElement)) return;
    const place = () => {
      const next = {
        x: Math.max(12, Math.min(point.x + 10, map.clientWidth - picker.offsetWidth - 12)),
        y: Math.max(12, Math.min(point.y + 10, map.clientHeight - picker.offsetHeight - 12)),
      };
      setPosition(current => current.x === next.x && current.y === next.y ? current : next);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(map);
    observer.observe(picker);
    return () => observer.disconnect();
  }, [point.x, point.y]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        restoreFocus.current = false;
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);
  return <div ref={ref} className="nearby-feature-picker" style={{ left: position.x, top: position.y }}
    role={menu ? 'menu' : 'dialog'} aria-label={menu ? 'Map actions' : 'Nearby map features'}
    onContextMenu={event => event.preventDefault()}
    onPointerDown={event => { pressed.current = event.button === 0 ? (event.target as HTMLElement).closest('button') : null; }}
    onPointerCancel={() => { pressed.current = null; }}
    onClickCapture={event => {
      // A long-press release over the newly opened menu is not a new action.
      if (event.detail !== 0 && pressed.current !== (event.target as HTMLElement).closest('button')) {
        event.preventDefault(); event.stopPropagation();
      }
      pressed.current = null;
    }}
    onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.nearby-feature-picker-list button')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    <div className="nearby-feature-picker-heading">
      <strong>{menu ? 'Map actions' : 'Nearby features'}</strong>
      <button className="ui-button ui-button--quiet ui-button--compact ui-button--icon" type="button" onClick={onClose}
        aria-label={menu ? 'Close map actions' : 'Close nearby features'}>×</button>
    </div>
    <div className="nearby-feature-picker-list">
      {actions.map(action => <button key={action.id} type="button" role="menuitem"
        onClick={() => {
          restoreFocus.current = false;
          if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
          onClose(); action.select();
        }}><strong>{action.label}</strong></button>)}
      {features.map(({ feature, routePointId, routeIndex }) => {
        const { kind, type, facilityType } = feature.properties;
        const category = (kind === 'navaid' ? normalizeNavaidType(type) : type) || facilityType || kind || 'FAA feature';
        return <button
          key={routeIndex === undefined ? `feature:${featureKey(feature)}` : `route:${routePointId}:${routeIndex}`} type="button" role={menu ? 'menuitem' : undefined}
          onClick={() => onSelect(feature, routePointId)}>
          <strong>{formatWaypointLabel(featureIdent(feature))}</strong>
          <span>{category}{routeIndex !== undefined && ` · On route · point ${routeIndex + 1}`} · {featureSubtitle(feature)}</span>
        </button>;
      })}
    </div>
  </div>;
}
