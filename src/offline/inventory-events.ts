const NAME = 'zlayer-offline-inventory';

export function notifyOfflineInventory(): void {
  globalThis.window?.dispatchEvent(new Event(NAME));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(NAME);
    channel.postMessage('changed');
    channel.close();
  }
}

export function observeOfflineInventory(refresh: () => void): () => void {
  // Focus does not change inventory. Refresh only for writes here or in another tab.
  window.addEventListener(NAME, refresh);
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(NAME) : undefined;
  if (channel) channel.onmessage = refresh;
  return () => {
    window.removeEventListener(NAME, refresh);
    channel?.close();
  };
}
