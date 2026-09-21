import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/b612/400.css';
import '@fontsource/b612/700.css';

import { preparePwa } from './pwa';
import { RESET_KEY, RESET_URL, WORKSPACE_LOCK, openResetScreen, resetPending, resetRequested } from './core/storage/reset';
import { observeVisibleViewport } from './core/ui/viewport';
import { observePwaBack } from './core/ui/pwa-back';
import { FirstVisit } from './shell/disclaimer';
import { PwaUpdatePrompt } from './shell/pwa-update';
import { StartupScreen } from './shell/startup-screen';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');

const stopObservingViewport = observeVisibleViewport();
if (import.meta.hot) import.meta.hot.dispose(stopObservingViewport);

window.addEventListener('storage', event => {
  // The controlling worker navigates its windows once the reset screen is ready.
  // A competing redirect here can replace a ready screen while its shell is deleted.
  if (event.key === RESET_KEY && event.newValue !== null && !navigator.serviceWorker?.controller) {
    openResetScreen();
  }
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

const view = createRoot(root);
const requested = resetRequested();
if (requested || new URL(location.href).searchParams.get('reset') === '1') {
  history.replaceState(null, '', RESET_URL);
  const { ResetScreen } = await import('./shell/reset-screen');
  view.render(<ResetScreen requested={requested} />);
} else {
  const stopObservingBack = observePwaBack();
  if (import.meta.hot) import.meta.hot.dispose(stopObservingBack);
  const start = async () => {
    if (resetPending()) { openResetScreen(); return; }
    view.render(<StartupScreen />);
    let App;
    try { ({ App } = await import('./app')); }
    catch { view.render(<StartupScreen message="The workspace could not open." slow />); return; }
    if (resetPending()) { openResetScreen(); return; }
    view.render(<StrictMode><FirstVisit><App /><PwaUpdatePrompt /></FirstVisit></StrictMode>);
    void preparePwa();
    // Unloading the document releases this lock, including all of its workers.
    await new Promise(() => {});
  };
  if (navigator.locks) void navigator.locks.request(WORKSPACE_LOCK, { mode: 'shared' }, start);
  else void start();
}
