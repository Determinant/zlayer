import { watchPwaUpdates } from './pwa-updates';

let registrationRequest: Promise<boolean> | undefined;
let stopWatchingUpdates: (() => void) | undefined;
if (import.meta.hot) import.meta.hot.dispose(() => stopWatchingUpdates?.());

export function preparePwa(): Promise<boolean> {
  if (!registrationRequest) {
    const request = registerServiceWorker();
    registrationRequest = request;
    void request.then(available => {
      if (!available && registrationRequest === request) registrationRequest = undefined;
    });
  }
  return registrationRequest;
}

async function registerServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const registration = await withDeadline(navigator.serviceWorker.register(
      import.meta.env?.DEV ? '/src/service-worker.ts' : '/sw.js',
      { type: 'module', scope: '/', updateViaCache: 'none' },
    )).catch(() => withDeadline(navigator.serviceWorker.getRegistration?.('/') ?? Promise.resolve(undefined)).catch(() => undefined));
    if (registration && !import.meta.env?.DEV) {
      stopWatchingUpdates?.();
      stopWatchingUpdates = watchPwaUpdates(registration);
    }
    // Re-registering while a reset screen still holds the old worker can revive
    // that registration without another install/activate event.
    if (registration?.installing && !await waitForControl(registration, navigator.serviceWorker)) return false;
    const worker = registration?.active ?? navigator.serviceWorker.controller;
    if (!worker) return false;
    await prepareWorker(worker);
    if (!await waitForControl({ installing: null }, navigator.serviceWorker)) return false;
    if (registration) reportShellWhenReady(registration);
    return true;
  } catch {
    return false;
  }
}

async function prepareWorker(worker: ServiceWorker): Promise<void> {
  const channel = new MessageChannel();
  try {
    const ready = new Promise<void>((resolve, reject) => {
      channel.port1.onmessage = event => event.data?.ok === true
        ? resolve() : reject(new Error('Offline worker could not prepare storage'));
    });
    worker.postMessage({ type: 'prepare-pwa' }, [channel.port2]);
    // Control alone is insufficient: an existing worker can still be rebuilding
    // its erased shell and rejecting cache writes after a reset.
    await withDeadline(ready);
  } finally { channel.port1.close(); }
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
