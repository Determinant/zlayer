import { LayerScope, type Dispose } from './scope';
import { createLayerStore, type LayerStore } from './store';
import type { LayerEvents } from './events';

export type PluginBridge<Apis> = {
  get<K extends keyof Apis & string>(id: K): Apis[K] | undefined;
  /** Called immediately, on provider changes, and when explicitly retrying a failure. */
  watch<K extends keyof Apis & string>(id: K,
    connect: (api: Apis[K] | undefined, scope: PluginScope) => void): Dispose;
};
export type PluginConnectionFailure = { providerId: string; message: string };
export type PluginConnectionRecovery = {
  /** Failed consumer watches; activation and healthy connections remain available. */
  failures: LayerStore<readonly PluginConnectionFailure[]>;
  retryFailed(): void;
};
export type PluginConnection = Partial<PluginConnectionRecovery> & { activate(): void; deactivate(): void };
export type PluginExports<Api, Dependencies = object> = {
  publicApi(scope: PluginScope): Api;
  connect?(bridge: PluginBridge<Dependencies>, scope: PluginScope): void;
};

export class PluginUnavailableError extends Error {
  constructor() { super('Plugin connection is no longer available'); this.name = 'PluginUnavailableError'; }
}

/** A connection's listeners, async work and commands share one revocable lifetime. */
export class PluginScope extends LayerScope {
  constructor(private readonly report: (error: unknown) => void = console.error) { super(report); }
  #run(action: () => void): void {
    if (this.signal.aborted) return;
    try { action(); } catch (error) { this.report(error); }
  }
  /** Subscribe before reading; initial delivery is part of connection setup. */
  observe<T>(store: LayerStore<T>, listener: (snapshot: T) => void): Dispose {
    if (this.signal.aborted) return () => {};
    const update = () => this.#run(() => listener(store.getSnapshot()));
    const stop = this.add(store.subscribe(update));
    if (!this.signal.aborted) listener(store.getSnapshot());
    return stop;
  }
  store<T>(source: LayerStore<T>): LayerStore<T> {
    return {
      getSnapshot: this.command(source.getSnapshot),
      subscribe: listener => this.signal.aborted ? () => {} : this.add(source.subscribe(() => this.#run(listener))),
    };
  }
  listen<T>(events: LayerEvents<T>, listener: (event: T) => void): Dispose {
    if (this.signal.aborted) return () => {};
    return this.add(events.subscribe(event => this.#run(() => listener(event))));
  }
  /** Explicit commands/queries stay ordinary functions, guarded once per call. */
  command<A extends unknown[], R>(action: (...args: A) => R): (...args: A) => R {
    const check = () => { if (this.signal.aborted) throw new PluginUnavailableError(); };
    return (...args) => {
      check();
      const result = action(...args);
      if (result instanceof Promise) return result.then(value => { check(); return value; },
        error => { check(); throw error; }) as R;
      // A synchronous command may intentionally close its own feature/attachment.
      return result;
    };
  }
}

type Provider = { api: unknown; scope: PluginScope };
type Watch = { update(): void; retry(): void };

/** The same recovery policy for a plugin registration and workspace-owned scopes. */
function createConnectionRecovery(report: (error: unknown) => void) {
  const failed = new Map<Watch, PluginConnectionFailure>();
  const store = createLayerStore<readonly PluginConnectionFailure[]>([]);
  const failures: PluginConnectionRecovery['failures'] = {
    getSnapshot: store.getSnapshot,
    subscribe: listener => store.subscribe(() => {
      // A status observer must not turn a consumer failure into a provider failure.
      try { listener(); } catch (error) { report(error); }
    }),
  };
  return {
    failures,
    retryFailed: () => { for (const watch of [...failed.keys()]) watch.retry(); },
    onFailure(watch: Watch, failure: PluginConnectionFailure | undefined) {
      if (failure) failed.set(watch, failure);
      else if (!failed.delete(watch)) return;
      store.publish([...failed.values()]);
    },
  };
}

/** Workspace-local discovery. No polling, serialization, global event bus or state copies. */
export class PluginRegistry<Apis> {
  readonly #providers = new Map<string, Provider>();
  readonly #watches = new Map<string, Set<Watch>>();
  readonly #pending = new Set<string>();
  #notifying = false;
  readonly #scopedRecovery: ReturnType<typeof createConnectionRecovery>;
  /** Connections created by forScope; plugin registrations own their own recovery. */
  readonly scopedConnections: PluginConnectionRecovery;
  constructor(private readonly report: (error: unknown) => void = console.error) {
    this.#scopedRecovery = createConnectionRecovery(report);
    this.scopedConnections = this.#scopedRecovery;
  }

  forScope(owner: LayerScope): PluginBridge<Apis> {
    return this.#forScope(owner, this.#scopedRecovery.onFailure);
  }

  #forScope(owner: LayerScope, onFailure: (watch: Watch, failure: PluginConnectionFailure | undefined) => void): PluginBridge<Apis> {
    return {
      get: id => owner.signal.aborted ? undefined : this.#providers.get(id)?.api as Apis[typeof id] | undefined,
      watch: (id, connect) => {
        if (owner.signal.aborted) return () => {};
        let previous: Provider | undefined;
        let initialized = false;
        let failed = false;
        let connection: PluginScope | undefined;
        let stopped = false;
        const watch: Watch = { update: () => {
          if (stopped || owner.signal.aborted) return;
          const provider = this.#providers.get(id);
          if (initialized && provider === previous) return;
          initialized = true; previous = provider;
          connection?.dispose();
          if (stopped || owner.signal.aborted || this.#providers.get(id) !== provider) return;
          connection = new PluginScope(this.report);
          const current = connection;
          let failure: PluginConnectionFailure | undefined;
          try { connect(provider?.api as Apis[typeof id] | undefined, current); }
          catch (error) {
            current.dispose(); this.report(error);
            failure = { providerId: id, message: error instanceof Error && error.message ? error.message : 'Connection failed' };
          }
          // Setup or cleanup may remove this watch or replace its provider.
          if (stopped || owner.signal.aborted || connection !== current || this.#providers.get(id) !== provider) return;
          failed = failure !== undefined;
          onFailure(watch, failure);
        }, retry: () => {
          if (!failed || stopped || owner.signal.aborted) return;
          initialized = false;
          this.#notify(id);
        } };
        let watches = this.#watches.get(id);
        if (!watches) this.#watches.set(id, watches = new Set());
        watches.add(watch);
        const stop = owner.add(() => {
          stopped = true;
          watches.delete(watch);
          if (!watches.size) this.#watches.delete(id);
          onFailure(watch, undefined);
          connection?.dispose(); connection = undefined;
        });
        // Initial delivery shares the same reentrancy rules as availability changes.
        this.#notify(id);
        return stop;
      },
    };
  }

  registration<K extends keyof Apis & string>(id: K,
    plugin: PluginExports<Apis[K], Apis> & { definition?: { id: string } }): PluginConnection {
    if (plugin.definition && plugin.definition.id !== id) throw new Error(`Plugin provider identity must match ${id}`);
    let provider: Provider | undefined;
    const recovery = createConnectionRecovery(this.report);
    return {
      failures: recovery.failures,
      retryFailed: recovery.retryFailed,
      activate: () => {
        if (provider) return;
        if (this.#providers.has(id)) throw new Error(`Duplicate plugin provider: ${id}`);
        const scope = new PluginScope(this.report);
        try {
          const api = plugin.publicApi(scope);
          provider = { api, scope };
          this.#providers.set(id, provider);
          // Connect before notifying others; scopes handle a provider removed by a callback.
          plugin.connect?.(this.#forScope(scope, recovery.onFailure), scope);
          this.#notify(id);
        } catch (error) {
          if (provider?.scope === scope) {
            if (this.#providers.get(id) === provider) this.#providers.delete(id);
            provider = undefined;
          }
          scope.dispose(); this.#notify(id);
          throw error;
        }
      },
      deactivate: () => {
        if (!provider) return;
        const removed = provider; provider = undefined;
        if (this.#providers.get(id) === removed) this.#providers.delete(id);
        // Revoke commands and owned consumers before telling other plugins.
        removed.scope.dispose();
        this.#notify(id);
      },
    };
  }

  #notify(id: string): void {
    this.#pending.add(id);
    if (this.#notifying) return;
    this.#notifying = true;
    try {
      while (this.#pending.size) {
        const next = this.#pending.values().next().value!;
        this.#pending.delete(next);
        const provider = this.#providers.get(next);
        for (const watch of [...this.#watches.get(next) ?? []]) {
          // A listener can remove/replace a provider. Deliver that transition next.
          if (this.#providers.get(next) !== provider) break;
          watch.update();
        }
      }
    } finally { this.#notifying = false; }
  }
}
