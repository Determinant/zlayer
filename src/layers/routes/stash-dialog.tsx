import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { routeDraftText, type RouteDraft } from '@zlayer/domain';
import { useBackDismiss } from '../../core/ui/pwa-back';
import { formatWaypointLabel } from '../../core/format/coordinates';
import { updateRouteStash, editSavedDraft, readRouteStash, ROUTE_STASH_KEY, savedRoute, type SavedRoute } from './stash';
import '../../core/ui/confirmation-dialog.css';
import './stash.css';

export type RouteStashView = { mode: 'list' } | { mode: 'save'; draft: RouteDraft };
type View = RouteStashView | { mode: 'edit'; route: SavedRoute };

function loadStash() {
  try { return { routes: readRouteStash(), error: '' }; }
  catch (error) { return { routes: [] as SavedRoute[], error: String((error as Error).message) }; }
}

export function RouteStashDialog({ initial, onLoad, onClose }: {
  initial: RouteStashView; onLoad: (draft: RouteDraft) => void; onClose: () => void;
}) {
  const [view, setView] = useState<View>(initial);
  const [state, setState] = useState(loadStash);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const heading = view.mode === 'save' ? 'Save route' : view.mode === 'edit' ? 'Edit saved route' : 'Route Stash';
  const refresh = () => setState(loadStash());
  const dismiss = () => {
    if (pending.current) return;
    if (view.mode === 'edit') { setView({ mode: 'list' }); setState(current => ({ ...current, error: '' })); }
    else onClose();
  };
  useBackDismiss(true, dialog, dismiss);

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useLayoutEffect(() => {
    if (view.mode === 'list') closeButton.current?.focus();
    else nameInput.current?.focus();
  }, [view.mode]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === ROUTE_STASH_KEY || event.key === null) refresh(); };
    window.addEventListener('storage', changed);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('focus', refresh); };
  }, []);

  const fail = (error: unknown) => setState(current => ({ ...current, error: (error as Error).message }));
  const change = async (update: (routes: SavedRoute[]) => SavedRoute[]) => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    try {
      const routes = await updateRouteStash(update);
      setState({ routes, error: '' });
      return true;
    } catch (error) { fail(error); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const save = async () => {
    try {
      if (view.mode === 'list') return;
      const next = view.mode === 'save' ? savedRoute(name, view.draft)
        : { ...view.route, name: name.trim(), draft: editSavedDraft(view.route.draft, text) };
      if (!await change(routes => {
        if (view.mode === 'save') return [...routes, next];
        const index = routes.findIndex(route => route.id === next.id);
        if (index < 0) throw new Error('This saved route was removed. Return to the stash to choose another.');
        if (JSON.stringify(routes[index]) !== JSON.stringify(view.route)) {
          throw new Error('This saved route changed in another window. Reopen it before editing.');
        }
        return routes.map(route => route.id === next.id ? next : route);
      })) return;
      setMessage(view.mode === 'save' ? 'Route saved.' : 'Saved route updated.');
      setView({ mode: 'list' });
    } catch (error) { fail(error); }
  };
  const load = (id: string) => {
    if (pending.current) return;
    try {
      const route = readRouteStash().find(route => route.id === id);
      if (!route) throw new Error('This saved route was removed. Refresh the stash to choose another.');
      onLoad(structuredClone(route.draft));
      onClose();
    } catch (error) { fail(error); }
  };
  const remove = async (id: string) => {
    if (!await change(routes => routes.filter(route => route.id !== id))) return;
    setMessage('Saved route removed.');
  };
  const move = async (id: string, direction: number) => {
    if (!await change(routes => {
      const index = routes.findIndex(route => route.id === id);
      if (index < 0) throw new Error('This saved route was removed. Refresh the stash.');
      const next = [...routes], [route] = next.splice(index, 1);
      next.splice(Math.max(0, Math.min(next.length, index + direction)), 0, route!);
      return next;
    })) return;
    setMessage(direction < 0 ? 'Saved route moved up.' : 'Saved route moved down.');
  };

  return createPortal(<dialog ref={dialog} className="confirmation-dialog route-stash-dialog" aria-labelledby={`${id}-title`} aria-busy={busy}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); dismiss(); }}>
    <header className="route-stash-heading">
      <h2 id={`${id}-title`}>{heading}</h2>
      <button ref={closeButton} type="button" className="route-stash-close" aria-label={`Close ${heading.toLowerCase()}`} disabled={busy} onClick={onClose}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </header>
    {view.mode === 'list' ? <div className="route-stash-body">
      <p className="route-stash-note">Saved on this device.</p>
      {state.error && <div className="route-stash-error" role="alert">{state.error} <button type="button" disabled={busy} onClick={refresh}>Retry</button></div>}
      <div className="route-stash-status" role="status">{message}</div>
      {!state.routes.length && !state.error && <p className="route-stash-empty">No saved routes yet. Use Save Route in the Route menu.</p>}
      <ol className="route-stash-list" aria-label="Saved routes">
        {state.routes.map((route, index) => <li key={route.id} aria-label={route.name || routeDraftText(route.draft)}>
          {route.name && <h3>{route.name}</h3>}
          <RouteStashSummary draft={route.draft} />
          <div className="route-stash-actions">
            <button type="button" className="route-stash-load" disabled={busy} onClick={() => load(route.id)}>Load</button>
            <button type="button" className="route-stash-icon" aria-label="Edit" title="Edit" disabled={busy} onClick={() => {
              setName(route.name); setText(routeDraftText(route.draft)); setView({ mode: 'edit', route });
              setState(current => ({ ...current, error: '' }));
            }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z" /></svg></button>
            <button type="button" className="route-stash-icon route-stash-remove" aria-label="Remove" title="Remove" disabled={busy} onClick={() => remove(route.id)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></svg>
            </button>
            <div className="route-stash-order">
              <button type="button" aria-label="Move up" title="Move up" disabled={busy || index === 0} onClick={() => move(route.id, -1)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>
              </button>
              <button type="button" aria-label="Move down" title="Move down" disabled={busy || index === state.routes.length - 1} onClick={() => move(route.id, 1)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 10 6 6 6-6" /></svg>
              </button>
            </div>
          </div>
        </li>)}
      </ol>
    </div> : <form className="route-stash-form" onSubmit={event => { event.preventDefault(); event.stopPropagation(); save(); }}>
      <div className="route-stash-body">
        <label className="route-stash-field" htmlFor={`${id}-name`}>Name <span>(optional)</span>
          <input ref={nameInput} id={`${id}-name`} type="text" maxLength={120} autoComplete="off" value={name} disabled={busy}
            onChange={event => setName(event.target.value)} />
        </label>
        {view.mode === 'save' ? <RouteStashSummary draft={view.draft} /> : <>
          <label className="route-stash-field" htmlFor={`${id}-route`}>Route
            <textarea id={`${id}-route`} value={text} rows={4} autoCapitalize="characters" spellCheck={false} disabled={busy}
              onChange={event => setText(event.target.value)} />
          </label>
          {view.route.draft.entries.some(entry => entry.approach || entry.departure) &&
            <p className="route-stash-note">Changing or removing an airport also removes its attached procedures.</p>}
        </>}
        {state.error && <p className="route-stash-error" role="alert">{state.error}</p>}
      </div>
      <footer className="confirmation-actions route-stash-footer">
        <button type="submit" className="confirmation-primary" disabled={busy || view.mode === 'edit' && !text.trim()}>
          {view.mode === 'save' ? 'Save' : 'Save changes'}
        </button>
        <button type="button" disabled={busy} onClick={dismiss}>Cancel</button>
      </footer>
    </form>}
  </dialog>, document.body);
}

function RouteStashSummary({ draft }: { draft: RouteDraft }) {
  return <div className="route-stash-path">
    {draft.entries.map(entry => <span key={entry.id} className={`route-stash-entry${entry.approach || entry.departure ? ' route-approach-bundle' : ''}${entry.departure ? ' has-departure' : ''}${entry.approach ? ' has-approach' : ''}`}>
      {(entry.approach || entry.departure) && <span className="route-approach-outline" aria-hidden="true" />}
      {entry.approach && <>
        <span className="route-stash-approach" title={`${entry.approach.name}${entry.approach.entry ? ` · ${entry.approach.entry.name}` : ''}`}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2v3a5 5 0 0 0 5 5h4M10 7l3 3-3 3" /></svg>
          <span>{entry.approach.name.replace(/\b(?:RWY|RUNWAY)\s+/gi, '')}{entry.approach.entry ? ` · ${entry.approach.entry.name}` : ''}</span>
        </span>
      </>}
      <span className="route-token route-stash-chip" title={entry.text}><strong>{formatWaypointLabel(entry.text)}</strong></span>
      {entry.departure && <span className="route-stash-approach" title={`${entry.departure.name} · ${entry.departure.branchName ?? 'Choose branch'} · ${entry.departure.transition}`}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12h3a5 5 0 0 0 5-5V3M7 6l3-3 3 3" /></svg>
        <span>{entry.departure.ident} · {entry.departure.branchName?.split(' · ')[0] ?? 'Choose branch'} · {entry.departure.transition}</span>
      </span>}
    </span>)}
  </div>;
}
