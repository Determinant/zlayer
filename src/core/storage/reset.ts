// A durable marker prevents a crashed/reloaded reset from reopening the workspace.
export const RESET_KEY = 'zlayer-reset-pending';
export const RESET_URL = '/?reset=1';
export const WORKSPACE_LOCK = 'zlayer-workspace';

export function resetPending(): boolean {
  try { return localStorage.getItem(RESET_KEY) !== null; } catch { return false; }
}

/** Remember why this tab navigated even if another tab has already finished. */
export function resetRequested(): boolean {
  if (resetPending()) return true;
  try { return sessionStorage.getItem(RESET_KEY) !== null; } catch { return false; }
}

export function openResetScreen(): void {
  try { sessionStorage.setItem(RESET_KEY, '1'); } catch { /* The shared marker still protects startup. */ }
  location.replace(RESET_URL);
}

export function beginReset(): void {
  resetLocks(); // Check before setting a marker that prevents workspace startup.
  try { localStorage.setItem(RESET_KEY, '1'); }
  catch { throw new Error('Storage is unavailable. Enable site storage and retry.'); }
  openResetScreen();
}

function resetLocks(): LockManager {
  if (!navigator.locks) throw new Error('Safe reset requires browser window coordination. Update your browser and retry.');
  return navigator.locks;
}

/** Called only from the isolated reset screen, after the workspace has unloaded. */
export async function purgeLocalData(progress: (message: string) => void): Promise<void> {
  const locks = resetLocks();
  const registrations = (await navigator.serviceWorker?.getRegistrations() ?? [])
    .filter(registration => registration.scope === `${location.origin}/`);
  const workers = new Set(registrations.flatMap(registration =>
    [registration.installing, registration.waiting, registration.active]).filter(worker => worker !== null));
  if (navigator.serviceWorker?.controller) workers.add(navigator.serviceWorker.controller);
  // An update can leave several live workers. Only one should navigate windows;
  // all of them must stop writes and wait for the reset screens to be ready.
  const coordinator = navigator.serviceWorker?.controller ?? registrations.find(registration => registration.active)?.active
    ?? workers.values().next().value;
  // Announce from every reset screen, even when another window owns the reset.
  // Its JS and styles are loaded and its tab-specific session data is gone.
  for (const worker of workers) worker.postMessage({ type: 'reset-screen-ready' });
  // Other reset screens wait here, and can take over if the owner closes.
  await locks.request('zlayer-reset', async () => {
    if (!resetPending()) return;
    progress('Stopping open workspaces and finishing pending storage writes…');
    await Promise.all([...workers].map(worker => requestWorkerReset(worker, 'prepare-reset', worker === coordinator)));
    try {
      await locks.request(WORKSPACE_LOCK, { signal: AbortSignal.timeout(15_000) }, async () => {
        progress('Removing saved regions, charts, plates, route, map view, and preferences…');
        // Keep the offline shell available until the other deletions have succeeded,
        // so a failed reset can still be reloaded and retried without a connection.
        await deleteDatabase('zlayer-offline');
        for (const key of Object.keys(localStorage)) {
          if (key !== RESET_KEY && isAppStorage(key)) localStorage.removeItem(key);
        }
        clearSessionData();
        const names = (await caches.keys()).filter(isAppStorage)
          .sort((a, b) => Number(a.startsWith('zlayers-shell-')) - Number(b.startsWith('zlayers-shell-')));
        for (const name of names) await caches.delete(name);
        for (const registration of registrations) await registration.unregister();
        await Promise.all([...workers].map(worker => requestWorkerReset(worker, 'finish-reset')));
        localStorage.removeItem(RESET_KEY);
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error('Close other ZLayer windows, then retry the reset.');
      }
      throw error;
    }
  });
}

export function clearSessionData(): void {
  for (const key of Object.keys(sessionStorage)) if (isAppStorage(key)) sessionStorage.removeItem(key);
}

function isAppStorage(name: string): boolean {
  return /^(?:zlayer(?:s)?[-:.]|awcplus[-:.])/i.test(name);
}

function requestWorkerReset(worker: ServiceWorker, type: 'prepare-reset' | 'finish-reset', navigateWindows = false): Promise<void> {
  if (worker.state === 'redundant') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      worker.removeEventListener('statechange', changed);
      if (error) reject(error); else resolve();
    };
    const changed = () => { if (worker.state === 'redundant') finish(); };
    const timeout = setTimeout(() => finish(new Error(
      'The offline worker has not stopped yet. Keep this screen open and retry; close other ZLayer windows if needed.',
    )), 180_000);
    channel.port1.onmessage = event => finish(event.data?.ok === true ? undefined : new Error(
      typeof event.data?.error === 'string' ? event.data.error : 'Offline worker could not stop safely',
    ));
    worker.addEventListener('statechange', changed);
    try { worker.postMessage({ type, navigateWindows }, [channel.port2]); }
    catch (error) { finish(error instanceof Error ? error : new Error('Offline worker could not be contacted')); }
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    const timeout = setTimeout(() => reject(new Error('Close other ZLayer windows, then retry the reset.')), 15_000);
    request.onsuccess = () => { clearTimeout(timeout); resolve(); };
    request.onerror = () => { clearTimeout(timeout); reject(request.error); };
  });
}
