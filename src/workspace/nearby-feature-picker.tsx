import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useBackDismiss } from '../core/ui/pwa-back';
import type { NearbyFeature, SelectFeature } from './feature-selection';
import { featureIdent, featureKey, featureSubtitle, normalizeNavaidType } from '@zlayer/domain';
import './nearby-feature-picker.css';

export function NearbyFeaturePicker({ features, point, onSelect, onClose }: {
  features: NearbyFeature[];
  point: { x: number; y: number };
  onSelect: SelectFeature;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useBackDismiss(true, ref, onClose);
  const previousFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(true);
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
    role="dialog" aria-label="Nearby map features">
    <div className="nearby-feature-picker-heading">
      <strong>Nearby features</strong>
      <button type="button" onClick={onClose} aria-label="Close nearby features">×</button>
    </div>
    <div className="nearby-feature-picker-list">
      {features.map(({ feature, routePointId, routeIndex }) => {
        const { kind, type, facilityType } = feature.properties;
        const category = (kind === 'navaid' ? normalizeNavaidType(type) : type) || facilityType || kind || 'FAA feature';
        return <button
          key={routeIndex === undefined ? `feature:${featureKey(feature)}` : `route:${routePointId}:${routeIndex}`} type="button"
          onClick={() => onSelect(feature, routePointId)}>
          <strong>{featureIdent(feature)}</strong>
          <span>{category}{routeIndex !== undefined && ` · On route · point ${routeIndex + 1}`} · {featureSubtitle(feature)}</span>
        </button>;
      })}
    </div>
  </div>;
}
