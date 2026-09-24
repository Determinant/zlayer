type Listener = () => void;
type Changes = { listeners: Set<Listener>; channel?: BroadcastChannel; queued: boolean };
const observers = new Map<string, Changes>();
const name = (plugin: string) => `zlayers-plugin-files-v1:${plugin}:changes`;
function channel(plugin: string): BroadcastChannel | undefined {
  try { return typeof window !== 'undefined' && window.BroadcastChannel ? new window.BroadcastChannel(name(plugin)) : undefined; }
  catch { return undefined; }
}
function deliver(state: Changes) {
  if (state.queued) return;
  state.queued = true;
  queueMicrotask(() => {
    state.queued = false;
    for (const listener of state.listeners) {
      try { listener(); } catch { /* Optional observers cannot break cache publication. */ }
    }
  });
}

/** Mutation hints only: consumers reconcile actual file presence, including on resume. */
export function subscribePluginFileChanges(plugin: string, listener: Listener): () => void {
  let state = observers.get(plugin);
  if (!state) {
    state = { listeners: new Set(), queued: false };
    const transport = channel(plugin), current = state;
    if (transport) { state.channel = transport; transport.onmessage = () => deliver(current); }
    observers.set(plugin, state);
  }
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
    if (!state.listeners.size && observers.get(plugin) === state) { state.channel?.close(); observers.delete(plugin); }
  };
}

export function notifyPluginFileChange(plugin: string): void {
  const state = observers.get(plugin);
  if (state) deliver(state);
  const transport = state?.channel ?? channel(plugin);
  try { transport?.postMessage(null); } catch { /* Cross-window notification is optional. */ }
  finally { if (!state?.channel) transport?.close(); }
}
