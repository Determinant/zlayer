import { useEffect, useId, useRef } from 'react';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { useMagneticModel } from '../../core/geo/use-magnetic-model';
import { useBackDismiss } from '../../core/ui/pwa-back';
import { fetchMagneticModel } from '../../workspace/catalog/catalog';
import { formatBearing, formatDistance, measure } from './measurement';
import type { RulerLayer } from './layer';
import '../../core/ui/map-tool-button.css';
import './styles.css';

export function RulerTool({ layer, revision }: { layer: RulerLayer; revision?: string }) {
  const state = useLayerSnapshot(layer);
  const model = useMagneticModel(revision, state.active, fetchMagneticModel);
  const root = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => { layer.close(); toggle.current?.focus({ preventScroll: true }); };
  useBackDismiss(state.active, root, close, 0);
  useEffect(() => {
    if (!state.active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented ||
        event.target instanceof Element && event.target.closest('input, textarea, select, dialog, [role="dialog"], .layer-menu')) return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    // Menus and editor gestures consume Escape before this window-level fallback.
    // The map's capture listener still cancels a ruler grip drag first.
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [state.active, layer]);
  const result = state.start && state.end ? measure(state.start, state.end, model) : null;
  const prompt = !state.start ? 'Choose start point A' : !state.end ? 'Choose end point B'
    : state.provisional ? 'Drag B to measure' : 'Drag A or B to adjust';
  return <div className="ruler-tool" ref={root}>
    <button ref={toggle} type="button" className="map-tool-button ruler-toggle" aria-label="Measure distance and bearing"
      title="Measure distance and bearing" aria-pressed={state.active} aria-controls={state.active ? id : undefined}
      onClick={() => state.active ? close() : layer.open()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 16 13-13 5 5-13 13Z" />
        <path d="m7 12 2 2m1-5 3 3m0-6 2 2" /></svg>
    </button>
    {state.active && <section id={id} className="ruler-card" aria-label="Ruler measurement">
      {result ? <div className="ruler-values" aria-label="Distance and initial bearings">
        <span><strong>{formatDistance(result.distance)}</strong> <span className="ruler-unit">NM</span></span>
        <span className="ruler-direction" aria-label="From A to B">A → B</span>
        <span className="ruler-bearings">
          <strong className="ruler-bearing" aria-label="Magnetic bearing" title="Initial magnetic bearing from A to B">
            {formatBearing(result.magnetic ? result.bearing : null, true)}</strong>
          <span className="ruler-true-bearing" aria-label="True bearing" title="Initial true bearing from A to B">
            {formatBearing(result.trueBearing, false)}</span>
        </span>
      </div> : <div className="ruler-title">Distance &amp; bearing</div>}
      <p className="ruler-prompt" role="status">{prompt}</p>
      {result && !result.magnetic && result.trueBearing !== null && <p className="ruler-reference">Magnetic bearing unavailable</p>}
      <div className="ruler-actions">
        <button className="ui-button ui-button--quiet ui-button--compact" type="button" onClick={() => layer.reverse()} disabled={!result || state.provisional} aria-label="Reverse ruler direction">
          <span aria-hidden="true">⇄</span> Reverse</button>
        <button className="ui-button ui-button--quiet ui-button--compact" type="button" onClick={() => layer.restart()} aria-label="New measurement">New</button>
        <button className="ui-button ui-button--quiet ui-button--compact" type="button" onClick={close} aria-label="Close ruler">Close</button>
      </div>
    </section>}
  </div>;
}
