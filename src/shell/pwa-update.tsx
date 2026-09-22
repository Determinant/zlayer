import { useSyncExternalStore } from 'react';
import { pwaUpdates, type PwaUpdateState } from '../pwa-updates';
import './pwa-update.css';

function usePwaUpdate() {
  return useSyncExternalStore(pwaUpdates.subscribe, pwaUpdates.snapshot, pwaUpdates.snapshot);
}

function UpdateButton({ state }: { state: PwaUpdateState }) {
  return <button className="ui-button ui-button--primary" type="button" disabled={state.applying} onClick={() => void pwaUpdates.apply()}>
    {state.applying ? 'Updating…' : 'Update now'}
  </button>;
}

export function PwaUpdatePrompt() {
  const state = usePwaUpdate();
  if (!state.availableRelease || state.dismissed) return null;
  return <aside className="pwa-update" aria-label="App update">
    <div role="status"><strong>Update available</strong>
      <p>Version <code>{state.availableVersion}</code> is ready.</p></div>
    <p>Reload to update. Your saved routes and downloads stay on this device.</p>
    {state.error && <p role="alert">{state.error}</p>}
    <div className="pwa-update-actions">
      <UpdateButton state={state} />
      <button className="ui-button ui-button--quiet" type="button" disabled={state.applying} onClick={pwaUpdates.dismiss}>Later</button>
    </div>
  </aside>;
}

export function PwaUpdateSettings() {
  const state = usePwaUpdate();
  return <section className="pwa-update-settings" aria-labelledby="app-update-title">
    <h3 id="app-update-title">App updates</h3>
    <p>Current version: <code>{state.currentVersion}</code></p>
    <p role="status">{state.availableRelease ? <>Update available: <code>{state.availableVersion}</code>.</>
      : state.downloading ? 'Downloading an update…'
        : state.checking ? 'Checking for updates…'
          : state.currentRelease === 'dev' ? 'Updates are available in production builds.'
            : state.checked && !state.error ? 'You’re up to date.' : 'Checks automatically when you return to the app.'}</p>
    {state.error && <p className="settings-error" role="alert">{state.error}</p>}
    <div className="pwa-update-actions">
      {state.availableRelease && <UpdateButton state={state} />}
      <button className="ui-button" type="button" disabled={state.checking || state.downloading || state.applying || state.currentRelease === 'dev'}
        onClick={() => void pwaUpdates.check()}>Check for updates</button>
    </div>
  </section>;
}
