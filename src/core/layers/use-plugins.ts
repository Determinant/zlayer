import { useEffect, useMemo, useRef, useState } from 'react';
import { usePersistentState } from '../ui/use-persistent-state';
import { pluginActivation, pluginContributions } from './activation';
import type { LayerPlugin } from './plugin';

export type PluginControl = { id: string; title: string; loaded: boolean; requires: readonly string[]; unloads: readonly string[] };
const validUnloaded = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string');

/** Controllers retain intent; their runtime attachments and UI can be unloaded. */
export function usePlugins(plugins: readonly LayerPlugin[]) {
  const policy = useMemo(() => pluginActivation(plugins), [plugins]);
  const [saved, setSaved] = usePersistentState<string[]>('plugins-unloaded', [], validUnloaded);
  const unloaded = useMemo(() => new Set(policy.normalize(saved)), [policy, saved]);
  const active = useMemo(() => plugins.filter(plugin => !unloaded.has(plugin.definition.id)), [plugins, unloaded]);
  const contributions = useMemo(() => pluginContributions(active), [active]);
  const previous = useRef<readonly LayerPlugin[]>([]);
  const [error, setError] = useState<string>();
  // Child attachment effects detach map/UI resources before feature cleanup.
  useEffect(() => {
    for (const plugin of [...previous.current].reverse()) if (!active.includes(plugin)) {
      try { plugin.dispose?.(); }
      catch (reason) { setError(`${plugin.definition.title}: ${reason instanceof Error ? reason.message : 'Cleanup failed'}`); }
    }
    previous.current = policy.activationOrder.filter(plugin => active.includes(plugin));
  }, [active, policy]);
  useEffect(() => () => {
    for (const plugin of [...previous.current].reverse()) {
      try { plugin.dispose?.(); } catch (error) { console.error(error); }
    }
    previous.current = [];
  }, []);
  return {
    ...contributions, error,
    isLoaded: (id: string) => !unloaded.has(id),
    controlsList: plugins.map(({ definition, requires = [] }): PluginControl => ({
      ...definition, loaded: !unloaded.has(definition.id), requires,
      unloads: policy.change([...unloaded], definition.id, false).filter(id => id !== definition.id && !unloaded.has(id)),
    })),
    setLoaded(id: string, loaded: boolean) {
      setError(undefined);
      setSaved(current => policy.change(current, id, loaded));
    },
  };
}
