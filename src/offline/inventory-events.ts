const NAME = 'zlayer-offline-inventory';

function openChannel(): BroadcastChannel | undefined {
  try { return typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(NAME) : undefined; }
  catch { return undefined; } // Optional cross-window delivery can be denied independently of storage.
}

export function notifyOfflineInventory(): void {
  globalThis.window?.dispatchEvent(new Event(NAME));
  const channel = openChannel();
  try { channel?.postMessage('changed'); }
  catch { /* The local event already ran; notification failure cannot undo a committed save. */ }
  finally { channel?.close(); }
}

export function observeOfflineInventory(refresh: () => void): () => void {
  // Focus does not change inventory. Refresh only for writes here or in another tab.
  window.addEventListener(NAME, refresh);
  const channel = openChannel();
  if (channel) channel.onmessage = refresh;
  return () => {
    window.removeEventListener(NAME, refresh);
    channel?.close();
  };
}
