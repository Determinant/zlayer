import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EdgePanel, EdgePanelFrame, EdgePanels, useEdgePanel, type PanelSide } from '../../src/core/ui/edge-panels';
import { LayerPanels } from '../../src/core/layers/panels';
import type { PanelLayer } from '../../src/core/layers/product';
import { observePwaBack } from '../../src/core/ui/pwa-back';
import '../../src/core/ui/edge-panels.css';
import '../../src/core/ui/edge-handle.css';

const query = new URLSearchParams(location.search);
const compact = query.get('layout') === 'compact';
const guarded = query.has('guard');
const layers: PanelLayer[] = (['left', 'right'] as const).flatMap(side =>
  ['a', 'b', 'c'].map((letter, order) => ({
    definition: { id: `${side}-${letter}`, title: `${side}-${letter}` },
    panel: { side, tab: { edge: 'bottom', order } },
    Panel: () => letter === 'c' ? <DeferredContribution name={`${side}-${letter}`} />
      : <Contribution name={`${side}-${letter}`} initiallyMounted guarded={guarded && letter === 'b'} />,
  })));

function DeferredContribution({ name }: { name: string }) {
  const panel = useEdgePanel(name);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const toggle = () => setMounted(value => !value);
    window.addEventListener(`toggle:${name}`, toggle);
    return () => window.removeEventListener(`toggle:${name}`, toggle);
  }, [name]);
  if (!mounted) return null;
  return <EdgePanelFrame panel={panel} label={name} className="edge-panel-window"
    icon={<path d="M3 3h18v18H3Z" />} style={compact ? { top: 'auto', bottom: 96, alignItems: 'flex-end' } : undefined}>
    <div {...panel.bodyProps} className="edge-panel-content edge-panel-body"><input aria-label={`${name} value`} /></div>
  </EdgePanelFrame>;
}

function Contribution({ name, initiallyMounted, guarded }: { name: string; initiallyMounted: boolean; guarded: boolean }) {
  const [mounted, setMounted] = useState(initiallyMounted);
  const [pending, setPending] = useState<{ proceed: () => boolean } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const toggle = () => setMounted(value => !value);
    window.addEventListener(`toggle:${name}`, toggle);
    return () => window.removeEventListener(`toggle:${name}`, toggle);
  }, [name]);
  useLayoutEffect(() => {
    if (pending) dialog.current?.showModal();
    else dialog.current?.close();
  }, [pending]);
  return <>
    {mounted && <EdgePanel autoOpen={false} icon={<path d="M3 3h18v18H3Z" />}
      beforeStow={(_next, proceed) => { if (!guarded) return true; setPending({ proceed }); return false; }}>
      {panel => <>
        <h2>{name}</h2>
        <input aria-label={`${name} value`} defaultValue="retained"
          onKeyDown={event => { if (event.key === 'Escape') event.preventDefault(); }} />
        <button onClick={() => panel.close(() => setMounted(false))}>Close {name}</button>
      </>}
    </EdgePanel>}
    <dialog ref={dialog} aria-label={`Stow ${name}?`} onCancel={event => { event.preventDefault(); setPending(null); }}>
      <button onClick={() => { pending?.proceed(); setPending(null); }}>Continue</button>
      <button onClick={() => setPending(null)}>Cancel</button>
    </dialog>
  </>;
}

function Fixture() {
  const [left, setLeft] = useState<string | null>(query.has('restore') ? 'left-c' : null);
  const [right, setRight] = useState<string | null>(query.has('restore') ? 'right-c' : null);
  const select = (side: PanelSide, name: string) => (side === 'left' ? setLeft : setRight)(name);
  return <>
    <header>{layers.map(layer => <span key={layer.definition.id}>
      <button onClick={() => select(layer.panel.side, layer.definition.id)}>Open {layer.definition.id}</button>
      <button onClick={() => window.dispatchEvent(new Event(`toggle:${layer.definition.id}`))}>Toggle {layer.definition.id}</button>
    </span>)}</header>
    <div id="panels">
      <EdgePanels side="left" active={left} onActiveChange={setLeft} individualTabs={compact}><LayerPanels layers={layers} /></EdgePanels>
      <EdgePanels side="right" active={right} onActiveChange={setRight} individualTabs={compact}><LayerPanels layers={layers} /></EdgePanels>
    </div>
  </>;
}

observePwaBack();
createRoot(document.getElementById('root')!).render(<Fixture />);
