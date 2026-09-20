export interface PwaUpdateState {
  currentRelease: string;
  currentVersion: string;
  availableRelease?: string | undefined;
  availableVersion?: string | undefined;
  dismissed: boolean;
  checking: boolean;
  downloading: boolean;
  applying: boolean;
  checked: boolean;
  error?: string | undefined;
}

interface PwaRelease { id: string; version: string }

/** Background activation stays automatic; this monitor reloads only on request. */
export class PwaUpdates {
  private state: PwaUpdateState;
  private listeners = new Set<() => void>();
  private registration: ServiceWorkerRegistration | undefined;
  private container: ServiceWorkerContainer | undefined;
  private stopWatching: (() => void) | undefined;
  private request: Promise<void> | undefined;
  private connection = 0;
  private inspection: { worker: ServiceWorker; connection: number; request: Promise<boolean> } | undefined;

  constructor(current: PwaRelease, private reload: () => void, private timeoutMs = 15_000) {
    this.state = { currentRelease: current.id, currentVersion: current.version,
      dismissed: false, checking: false, downloading: false, applying: false, checked: false };
  }

  snapshot = (): PwaUpdateState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<PwaUpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  connect(registration: ServiceWorkerRegistration, container: ServiceWorkerContainer): void {
    if (this.registration === registration && this.container === container) return;
    this.disconnect();
    this.registration = registration;
    this.container = container;
    let installing: ServiceWorker | null = null;
    let controlling: ServiceWorker | null = null;
    const inspect = () => { void this.inspect(); };
    const controllerStateChanged = () => {
      if (controlling?.state === 'activated') {
        if (!registration.installing) this.publish({ downloading: false });
        inspect();
      }
    };
    const controllerChanged = () => {
      controlling?.removeEventListener('statechange', controllerStateChanged);
      controlling = container.controller;
      // clients.claim() can notify a page before the worker finishes activation.
      // A resumed/new page may have missed updatefound and have no installing worker.
      controlling?.addEventListener('statechange', controllerStateChanged);
      this.publish({ availableRelease: undefined, availableVersion: undefined, checked: false,
        downloading: Boolean(registration.installing) || controlling?.state === 'activating' });
      controllerStateChanged();
    };
    const changed = () => {
      if (installing?.state === 'redundant') {
        installing.removeEventListener('statechange', changed);
        this.publish({ downloading: false, error: 'The update could not be downloaded. Try checking again.' });
      } else if (installing?.state === 'activated') {
        installing.removeEventListener('statechange', changed);
        this.publish({ downloading: false });
        inspect();
      }
    };
    const found = () => {
      installing?.removeEventListener('statechange', changed);
      installing = registration.installing;
      if (!installing) return;
      this.publish({ downloading: true, checked: false, error: undefined });
      installing.addEventListener('statechange', changed);
      changed();
    };
    registration.addEventListener('updatefound', found);
    container.addEventListener('controllerchange', controllerChanged);
    this.stopWatching = () => {
      registration.removeEventListener('updatefound', found);
      container.removeEventListener('controllerchange', controllerChanged);
      installing?.removeEventListener('statechange', changed);
      controlling?.removeEventListener('statechange', controllerStateChanged);
    };
    found();
    controllerChanged();
  }

  private inspect(): Promise<boolean> {
    const worker = this.container?.controller;
    if (!worker || worker.state !== 'activated') return Promise.resolve(false);
    const connection = this.connection;
    if (this.inspection?.worker === worker && this.inspection.connection === connection) return this.inspection.request;
    const request = readRelease(worker, this.timeoutMs).then(release => {
      if (connection !== this.connection || worker !== this.container?.controller || worker.state !== 'activated') return false;
      const availableRelease = release.id !== this.state.currentRelease ? release.id : undefined;
      this.publish({ availableRelease, availableVersion: availableRelease ? release.version : undefined,
        ...(availableRelease !== this.state.availableRelease ? { dismissed: false, error: undefined } : {}) });
      return true;
    }).catch(() => {
      // A legacy worker or a temporarily suspended mobile process may not reply.
      // A later controller change or foreground check will retry.
      return false;
    }).finally(() => { if (this.inspection?.request === request) this.inspection = undefined; });
    this.inspection = { worker, connection, request };
    return request;
  }

  check = (): Promise<void> => {
    if (this.request) return this.request;
    const registration = this.registration;
    if (!registration) {
      this.publish({ error: 'App updates are not ready yet. Try again in a moment.' });
      return Promise.resolve();
    }
    if (registration.installing) return Promise.resolve();
    const connection = this.connection;
    this.publish({ checking: true, checked: false, error: undefined });
    // Start after assigning request so even a synchronous API exception leaves
    // the coalescing state retryable, and stale requests cannot clear a new one.
    const request = Promise.resolve().then(async () => {
      try {
        await withTimeout(registration.update(), this.timeoutMs);
        if (connection !== this.connection) return;
        const inspected = await this.inspect();
        if (connection !== this.connection) return;
        if (inspected) this.publish({ checked: !this.state.downloading && !registration.installing && !registration.waiting });
        else if (!this.state.downloading) this.publish({ error: 'Could not confirm the installed release. Try checking again.' });
      } catch {
        if (connection === this.connection) this.publish({ error: 'Could not check for updates. Check your connection and try again.' });
      }
    }).finally(() => {
      if (this.request === request) {
        this.request = undefined;
        this.publish({ checking: false });
      }
    });
    this.request = request;
    return request;
  };

  dismiss = (): void => { this.publish({ dismissed: true }); };

  apply = async (): Promise<void> => {
    if (!this.state.availableRelease || this.state.applying) return;
    const connection = this.connection;
    this.publish({ applying: true, error: undefined });
    try {
      const worker = this.container?.controller;
      if (!worker || worker.state !== 'activated') throw new Error('Worker not ready');
      const release = await readRelease(worker, this.timeoutMs);
      if (connection !== this.connection) return;
      if (worker !== this.container?.controller || release.id === this.state.currentRelease) throw new Error('Release changed');
      // Navigation now uses the already-installed shell, including while offline.
      // Keep applying=true until navigation so a double tap cannot reload twice.
      this.reload();
    } catch {
      if (connection === this.connection) this.publish({ applying: false, error: 'The update is not ready. Check for updates and try again.' });
    }
  };

  disconnect(): void {
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.connection++;
    this.inspection = undefined;
    this.request = undefined;
    this.registration = undefined;
    this.container = undefined;
    this.publish({ checking: false, checked: false, downloading: false, applying: false,
      availableRelease: undefined, availableVersion: undefined, error: undefined });
  }
}

async function readRelease(worker: ServiceWorker, timeoutMs: number): Promise<PwaRelease> {
  const channel = new MessageChannel();
  try {
    const reply = new Promise<PwaRelease>((resolve, reject) => {
      channel.port1.onmessage = event => {
        const release: unknown = event.data?.release;
        const displayVersion: unknown = event.data?.displayVersion;
        if (typeof release !== 'string' || !/^(?:[a-f0-9]{16}|dev)$/.test(release)) {
          reject(new Error('Invalid app release')); return;
        }
        // Legacy workers report only the ID. Never compare truncated display hashes.
        if (displayVersion === undefined) resolve({ id: release, version: release });
        else if (typeof displayVersion === 'string' && (release === 'dev' && displayVersion === 'dev' ||
          /^v\d+\.\d+\.\d+(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?\+g[a-f0-9]{7}\.b[a-f0-9]{8}$/.test(displayVersion) &&
          displayVersion.endsWith(`.b${release.slice(0, 8)}`))) resolve({ id: release, version: displayVersion });
        else reject(new Error('Invalid app version'));
      };
      worker.postMessage({ type: 'app-release' }, [channel.port2]);
    });
    return await withTimeout(reply, timeoutMs);
  } finally { channel.port1.close(); channel.port2.close(); }
}

async function withTimeout<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Update request timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

const currentRelease = typeof document === 'undefined' ? 'dev'
  : document.querySelector<HTMLMetaElement>('meta[name="zlayer-release"]')?.content ?? 'dev';
const currentVersion = typeof document === 'undefined' ? 'dev'
  : document.querySelector<HTMLMetaElement>('meta[name="zlayer-version"]')?.content ?? currentRelease;
export const pwaUpdates = new PwaUpdates({ id: currentRelease, version: currentVersion }, () => location.reload());

/** Mobile apps are often resumed, without any navigation to trigger a browser check. */
export function watchPwaUpdates(registration: ServiceWorkerRegistration): () => void {
  pwaUpdates.connect(registration, navigator.serviceWorker);
  let lastCheck = -Infinity;
  const check = () => {
    if (document.visibilityState !== 'visible' || navigator.onLine === false || Date.now() - lastCheck < 30_000) return;
    lastCheck = Date.now();
    void pwaUpdates.check();
  };
  const online = () => { lastCheck = -Infinity; check(); };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('pageshow', check);
  window.addEventListener('focus', check);
  window.addEventListener('online', online);
  const interval = setInterval(check, 5 * 60_000);
  check();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('pageshow', check);
    window.removeEventListener('focus', check);
    window.removeEventListener('online', online);
    pwaUpdates.disconnect();
  };
}
