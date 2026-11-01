import { watchPwaUpdates } from './pwa-updates';

const preparations = new Map<boolean, { controller: ServiceWorker | null; request: Promise<boolean> }>();
let watchedRegistration: ServiceWorkerRegistration | undefined;
let stopWatchingUpdates: (() => void) | undefined;
if (import.meta.hot) import.meta.hot.dispose(() => stopWatchingUpdates?.());

export function preparePwa(): Promise<boolean> {
  return prepare(true);
}

/** Reading saved charts does not require downloading or repairing the app shell. */
export function prepareChartCache(): Promise<boolean> {
  return prepare(false);
}

function prepare(requireShell: boolean): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return Promise.resolve(false);
  const controller = navigator.serviceWorker.controller;
  const pending = preparations.get(requireShell);
  if (pending?.controller === controller) return pending.request;
  const request = registerServiceWorker(requireShell);
  preparations.set(requireShell, { controller, request });
  void request.finally(() => {
    if (preparations.get(requireShell)?.request === request) preparations.delete(requireShell);
  });
  return request;
}

async function registerServiceWorker(requireShell: boolean): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    // An existing registration is local browser state. Do not put a network
    // registration/update attempt ahead of an installed app's offline reads.
    let registration = await withDeadline(navigator.serviceWorker.getRegistration?.('/') ?? Promise.resolve(undefined))
      .catch(() => undefined);
    // Reset can unregister a worker while an open window still holds it. Revive
    // that registration so the next process also has an installed offline app.
    if (import.meta.env?.DEV || !registration) registration = await withDeadline(navigator.serviceWorker.register(
      import.meta.env?.DEV ? '/src/service-worker.ts' : '/sw.js',
      { type: 'module', scope: '/', updateViaCache: 'none' },
    )).catch(() => withDeadline(navigator.serviceWorker.getRegistration?.('/') ?? Promise.resolve(undefined)).catch(() => undefined));
    if (registration && registration !== watchedRegistration && !import.meta.env?.DEV) {
      stopWatchingUpdates?.();
      stopWatchingUpdates = watchPwaUpdates(registration);
      watchedRegistration = registration;
    }
    // An installed controller remains usable while an update is installing.
    // A first installation must finish before we can ask it to prepare storage.
    if (!navigator.serviceWorker.controller && !registration?.active && registration?.installing &&
      !await waitForControl(registration, navigator.serviceWorker)) return false;
    const worker = navigator.serviceWorker.controller ?? registration?.active;
    if (!worker) return false;
    await prepareWorker(worker, requireShell);
    if (!await waitForControl({ installing: null }, navigator.serviceWorker)) return false;
    if (navigator.serviceWorker.controller !== worker) return false;
    if (registration) reportShellWhenReady(registration);
    return true;
  } catch {
    return false;
  }
}

async function prepareWorker(worker: ServiceWorker, requireShell: boolean): Promise<void> {
  const channel = new MessageChannel();
  try {
    const ready = new Promise<void>((resolve, reject) => {
      channel.port1.onmessage = event => event.data?.ok === true
        ? resolve() : reject(new Error('Offline worker could not prepare storage'));
    });
    worker.postMessage({ type: 'prepare-pwa', requireShell }, [channel.port2]);
    // Control alone is insufficient: an existing worker can still be rebuilding
    // its erased shell and rejecting cache writes after a reset.
    await withDeadline(ready);
  } finally { channel.port1.close(); channel.port2.close(); }
}

async function withDeadline<T>(request: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Service worker registration timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Readiness never waits indefinitely for a failed first install. */
export function waitForControl(
  registration: Pick<ServiceWorkerRegistration, 'installing'>,
  container: Pick<ServiceWorkerContainer, 'controller' | 'addEventListener' | 'removeEventListener'>,
  timeoutMs = 15_000,
): Promise<boolean> {
  const installing = registration.installing;
  if (!installing && container.controller) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (available: boolean) => {
      clearTimeout(timeout);
      container.removeEventListener('controllerchange', changed);
      installing?.removeEventListener('statechange', changed);
      resolve(available);
    };
    const changed = () => {
      if (installing?.state === 'redundant') finish(false);
      else if (container.controller && (!installing ||
        (installing.state === 'activated' && container.controller === installing))) finish(true);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    container.addEventListener('controllerchange', changed);
    installing?.addEventListener('statechange', changed);
    changed();
  });
}

function reportShellWhenReady(registration: ServiceWorkerRegistration): void {
  const send = () => {
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
    if (entry) registration.active?.postMessage({ type: 'active-shell', entry });
  };
  if (document.readyState === 'complete') send();
  else window.addEventListener('load', send, { once: true });
}
