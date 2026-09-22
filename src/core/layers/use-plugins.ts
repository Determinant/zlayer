import { useEffect, useMemo, useRef, useState } from 'react';
import { usePersistentState } from '../ui/use-persistent-state';
import { pluginActivation, pluginContributions } from './activation';
import type { LayerPlugin } from './plugin';

export type PluginControl = {
  id: string; title: string; enabled: boolean; loaded: boolean;
  status: 'disabled' | 'starting' | 'ready' | 'degraded' | 'failed' | 'blocked';
  error: string | undefined; requires: readonly string[]; unloads: readonly string[];
};
const validUnloaded = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string');

function disposePlugin(plugin: LayerPlugin, report: (reason: unknown) => void): void {
  try { plugin.communication?.deactivate(); } catch (reason) { report(reason); }
  try { plugin.dispose?.(); } catch (reason) { report(reason); }
}

/** Controllers retain intent; their runtime attachments and UI can be unloaded. */
export function usePlugins(plugins: readonly LayerPlugin[]) {
  const policy = useMemo(() => pluginActivation(plugins), [plugins]);
  const [saved, setSaved] = usePersistentState<string[]>('plugins-unloaded', [], validUnloaded);
  const unloaded = useMemo(() => new Set(policy.normalize(saved)), [policy, saved]);
  const requested = useMemo(() => plugins.filter(plugin => !unloaded.has(plugin.definition.id)), [plugins, unloaded]);
  // null means activation succeeded; a string records a failed attempt until retry.
  const attempts = useRef(new Map<LayerPlugin, string | null>());
  const [states, setStates] = useState<ReadonlyMap<LayerPlugin, string | null>>(() => new Map());
  const active = useMemo(() => {
    const unavailable = new Set(policy.normalize([...unloaded,
      ...plugins.filter(plugin => states.get(plugin) !== null).map(plugin => plugin.definition.id)]));
    return plugins.filter(plugin => !unavailable.has(plugin.definition.id));
  }, [plugins, policy, unloaded, states]);
  const contributions = useMemo(() => pluginContributions(active), [active]);
  const loadedIds = new Set(active.map(plugin => plugin.definition.id));
  const failedIds = new Set(policy.normalize(plugins.filter(plugin => typeof states.get(plugin) === 'string')
    .map(plugin => plugin.definition.id)));
  const [error, setError] = useState<string>();
  const [connectionErrors, setConnectionErrors] = useState<ReadonlyMap<LayerPlugin, string>>(() => new Map());
  useEffect(() => {
    const update = () => setConnectionErrors(new Map(plugins.map(plugin => [plugin,
      plugin.communication?.failures?.getSnapshot().map(failure => `${failure.providerId}: ${failure.message}`).join('; ') ?? '',
    ])));
    const stops = plugins.flatMap(plugin => plugin.communication?.failures?.subscribe(update) ?? []);
    update();
    return () => { for (const stop of stops) stop(); };
  }, [plugins]);
  // Child attachment effects detach map/UI resources before feature cleanup.
  useEffect(() => {
    const current = attempts.current;
    const unavailable = new Set(policy.normalize([...unloaded,
      ...plugins.filter(plugin => current.get(plugin) !== null).map(plugin => plugin.definition.id)]));
    const reportCleanup = (plugin: LayerPlugin, reason: unknown) =>
      setError(`${plugin.definition.title}: ${reason instanceof Error ? reason.message : 'Cleanup failed'}`);
    for (const [plugin, failure] of [...current].reverse()) {
      if (requested.includes(plugin) && (failure !== null || !unavailable.has(plugin.definition.id))) continue;
      if (failure === null) disposePlugin(plugin, reason => reportCleanup(plugin, reason));
      current.delete(plugin);
    }
    const ready = new Set([...current].filter(([, failure]) => failure === null).map(([plugin]) => plugin.definition.id));
    for (const plugin of policy.activationOrder) {
      if (!requested.includes(plugin) || current.has(plugin) || plugin.requires?.some(id => !ready.has(id))) continue;
      try {
        plugin.communication?.activate();
        current.set(plugin, null);
        ready.add(plugin.definition.id);
      } catch (reason) {
        disposePlugin(plugin, error => reportCleanup(plugin, error));
        current.set(plugin, reason instanceof Error && reason.message ? reason.message : 'Connection failed');
      }
    }
    // Retain prerequisite order even when an earlier plugin was re-enabled later.
    attempts.current = new Map(policy.activationOrder.filter(plugin => current.has(plugin))
      .map(plugin => [plugin, current.get(plugin)!]));
    setStates(new Map(attempts.current));
  }, [requested, policy, plugins, unloaded]);
  useEffect(() => () => {
    for (const [plugin, failure] of [...attempts.current].reverse()) {
      if (failure === null) disposePlugin(plugin, error => console.error(error));
    }
    attempts.current.clear();
  }, []);
  return {
    ...contributions, error,
    isLoaded: (id: string) => loadedIds.has(id),
    controlsList: plugins.map((plugin): PluginControl => {
      const { definition, requires = [] } = plugin;
      const enabled = !unloaded.has(definition.id), loaded = loadedIds.has(definition.id);
      const failure = states.get(plugin);
      const connectionError = loaded ? connectionErrors.get(plugin) : undefined;
      return { ...definition, enabled, loaded, requires,
        status: !enabled ? 'disabled' : loaded ? connectionError ? 'degraded' : 'ready' : typeof failure === 'string' ? 'failed'
          : failedIds.has(definition.id) ? 'blocked' : 'starting',
        error: enabled && typeof failure === 'string' ? failure : connectionError || undefined,
        unloads: policy.change([...unloaded], definition.id, false).filter(id => id !== definition.id && !unloaded.has(id)),
      };
    }),
    setLoaded(id: string, loaded: boolean) {
      setError(undefined);
      if (loaded) {
        // Reuse enable for explicit retry, including failed prerequisites. Healthy
        // providers keep their connections; unrelated failures are left alone.
        const excluded = new Set(policy.change(plugins.map(plugin => plugin.definition.id), id, true));
        for (const [plugin, failure] of attempts.current) {
          if (excluded.has(plugin.definition.id)) continue;
          if (failure !== null) attempts.current.delete(plugin);
          else plugin.communication?.retryFailed?.();
        }
      }
      setSaved(current => policy.change(current, id, loaded));
    },
  };
}
