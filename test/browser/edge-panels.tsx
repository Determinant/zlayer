import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EdgePanel, EdgePanelFrame, EdgePanels, useEdgePanel, type PanelSide } from '../../src/core/ui/edge-panels';
import { PanelSurface, FullScreenButton } from '../../src/core/ui/panel-surface';
import { LayerPanels } from '../../src/core/layers/panels';
import type { PanelContribution } from '../../src/core/layers/plugin';
import type { PanelLayout } from '../../src/core/layers/panel-layout';
import { observePwaBack } from '../../src/core/ui/pwa-back';
import '../../src/core/ui/edge-panels.css';
import '../../src/core/ui/edge-handle.css';

const query = new URLSearchParams(location.search);
const compact = query.get('layout') === 'compact';
const guarded = query.has('guard');
const panels: PanelContribution[] = (['left', 'right'] as const).flatMap(side =>
  ['a', 'b', 'c'].map(letter => ({
    id: `${side}-${letter}`, title: `${side}-${letter}`,
    Component: () => query.has('surface') && letter === 'a' ? <SurfaceContribution name={`${side}-${letter}`} />
      : letter === 'c' ? <DeferredContribution name={`${side}-${letter}`} />
      : <Contribution name={`${side}-${letter}`} initiallyMounted guarded={guarded && letter === 'b'} />,
  })));

const layout: PanelLayout = Object.fromEntries((['left', 'right'] as const).flatMap(side =>
  ['a', 'b', 'c'].map((letter, order) => [`${side}-${letter}`, { side, tab: { edge: 'bottom', order } }])));

function SurfaceContribution({ name }: { name: string }) {
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    const toggle = () => setMounted(value => !value);
    window.addEventListener(`toggle:${name}`, toggle);
    return () => window.removeEventListener(`toggle:${name}`, toggle);
  }, [name]);
  return mounted ? <SurfaceBody name={name} /> : null;
}

function SurfaceBody({ name }: { name: string }) {
  const panel = useEdgePanel(name);
  const [expanded, setExpanded] = useState(query.has('expanded'));
  const button = useRef<HTMLButtonElement>(null);
  return <EdgePanelFrame panel={panel} label={name} className="edge-panel-window" icon={<path d="M3 3h18v18H3Z" />}>
    <PanelSurface {...panel.bodyProps} visible={panel.open} expanded={expanded} onExitFullScreen={() => setExpanded(false)}
      fullScreenButton={button} className="edge-panel-content edge-panel-body" aria-label={`${name} surface`}>
      <input aria-label={`${name} value`} defaultValue="retained" />
      <FullScreenButton expanded={expanded} button={button} onClick={() => setExpanded(value => !value)} />
    </PanelSurface>
  </EdgePanelFrame>;
}

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
    <header>{panels.map(panel => <span key={panel.id}>
      <button onClick={() => select(layout[panel.id]!.side, panel.id)}>Open {panel.id}</button>
      <button onClick={() => window.dispatchEvent(new Event(`toggle:${panel.id}`))}>Toggle {panel.id}</button>
    </span>)}</header>
    <div id="panels">
      <EdgePanels side="left" active={left} onActiveChange={setLeft} individualTabs={compact}><LayerPanels panels={panels} layout={layout} /></EdgePanels>
      <EdgePanels side="right" active={right} onActiveChange={setRight} individualTabs={compact}><LayerPanels panels={panels} layout={layout} /></EdgePanels>
    </div>
  </>;
}

observePwaBack();
createRoot(document.getElementById('root')!).render(<Fixture />);
