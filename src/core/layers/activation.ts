import type { LayerPlugin } from './plugin';

/** Saved intent lists unloaded plugins so newly installed built-ins start loaded. */
export function pluginActivation(plugins: readonly LayerPlugin[]) {
  const byId = new Map(plugins.map(plugin => [plugin.definition.id, plugin]));
  const activationOrder: LayerPlugin[] = [];
  const visited = new Set<string>();
  const visit = (id: string, path: string[] = []) => {
    const plugin = byId.get(id);
    if (!plugin) throw new Error(`Unknown plugin: ${id}`);
    if (path.includes(id)) throw new Error(`Plugin dependency cycle: ${[...path, id].join(' → ')}`);
    if (visited.has(id)) return;
    for (const dependency of plugin.requires ?? []) visit(dependency, [...path, id]);
    visited.add(id); activationOrder.push(plugin);
  };
  for (const id of byId.keys()) visit(id);
  const normalize = (unloaded: readonly string[]) => {
    const disabled = new Set(unloaded.filter(id => byId.has(id)));
    let changed = true;
    while (changed) {
      changed = false;
      for (const plugin of plugins) if (!disabled.has(plugin.definition.id) && plugin.requires?.some(id => disabled.has(id))) {
        disabled.add(plugin.definition.id); changed = true;
      }
    }
    return [...byId.keys()].filter(id => disabled.has(id));
  };
  return {
    activationOrder,
    normalize,
    change(unloaded: readonly string[], id: string, loaded: boolean) {
      visit(id);
      const disabled = new Set(normalize(unloaded));
      if (!loaded) return normalize([...disabled, id]);
      const load = (id: string) => {
        for (const dependency of byId.get(id)!.requires ?? []) load(dependency);
        disabled.delete(id);
      };
      load(id);
      return normalize([...disabled]);
    },
  };
}

export function pluginContributions(plugins: readonly LayerPlugin[]) {
  return {
    panels: plugins.flatMap(plugin => plugin.panels ?? []),
    controls: plugins.flatMap(plugin => plugin.controls ?? []),
    overlays: plugins.flatMap(plugin => plugin.overlays ?? []),
    footer: plugins.flatMap(plugin => plugin.footer ?? []),
    mapContributions: plugins.flatMap(plugin => plugin.mapContribution ? [plugin.mapContribution] : []),
  };
}
