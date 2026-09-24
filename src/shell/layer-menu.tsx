import { useEffect, useId, useRef } from 'react';
import { usePersistentState } from '../core/ui/use-persistent-state';
import { useBackDismiss } from '../core/ui/pwa-back';
import { isBoolean } from '../core/storage/ui-state';
import { LayerContributions } from '../core/layers/contributions';
import type { UiContribution } from '../core/layers/plugin';
import '../core/ui/map-tool-button.css';

function MapDisplayControls({ controls }: { controls: readonly UiContribution[] }) {
  const groups = new Map<string, { title?: string; contributions: UiContribution[] }>();
  for (const control of controls) {
    const key = control.section ? `section:${control.section.id}` : `control:${control.id}`;
    const group = groups.get(key);
    if (group) group.contributions.push(control);
    else groups.set(key, { ...(control.section ? { title: control.section.title } : {}), contributions: [control] });
  }
  return [...groups].map(([key, { title, contributions }]) => title
    ? <section className="layer-section" key={key} aria-label={title}>
      <div className="section-title"><h3>{title}</h3></div>
      <div className="layer-control-group"><LayerContributions contributions={contributions} /></div>
    </section>
    : <LayerContributions key={key} contributions={contributions} />);
}

export function LayerMenu({ controls, footer, activeCount, visibleFeatureCount }: {
  controls: readonly UiContribution[]; footer: readonly UiContribution[]; activeCount: number; visibleFeatureCount: number;
}) {
  const [open, setOpen] = usePersistentState('layers-open', false, isBoolean);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useBackDismiss(open, menuRef, () => { setOpen(false); buttonRef.current?.focus(); });
  const popoverId = useId();
  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="layer-menu" ref={menuRef}>
      <button
        ref={buttonRef}
        className={`map-tool-button layer-control-button ${open ? 'is-open' : ''}`}
        type="button"
        aria-label={open ? 'Close map layers' : 'Open map layers'}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 3 8 4-8 4-8-4 8-4Z" />
          <path d="m4 11 8 4 8-4" />
          <path d="m4 15 8 4 8-4" />
        </svg>
        <span className="active-layer-count">{activeCount}</span>
      </button>

      {open && (
        <aside
          className="layer-popover"
          id={popoverId}
          role="dialog"
          aria-label="Map layers"
        >
          <div className="layer-popover-content panel-scroll">
            <div className="panel-heading">
              <h2>Map Display</h2>
              <span className="feature-count">
                {visibleFeatureCount.toLocaleString()} loaded
              </span>
            </div>

            <MapDisplayControls controls={controls} />
            <LayerContributions contributions={footer} />
          </div>
        </aside>
      )}
    </div>
  );
}
