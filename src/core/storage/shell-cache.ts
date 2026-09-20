export const SHELL_CACHE_PREFIX = 'zlayers-shell-';

/** Called only when the reporting page is the sole open app window. */
export async function pruneShellCaches(current: string, entry: string, origin: string, canPrune = () => true): Promise<void> {
  if (!canPrune()) return;
  const names = (await caches.keys()).filter(name => name.startsWith(SHELL_CACHE_PREFIX));
  const path = new URL(entry).pathname;
  const keep = new Set([current]);
  let recognized = false;
  for (const name of names) {
    const html = await (await caches.open(name)).match(`${origin}/`);
    if (html && (await html.text()).includes(path)) {
      keep.add(name);
      recognized = true;
    }
  }
  // A legacy/unknown page may still need any of its release's lazy assets.
  if (!recognized) return;
  for (const name of names) {
    // Installation or activation can begin while the cache inventory is read.
    if (!canPrune()) return;
    if (!keep.has(name)) await caches.delete(name);
  }
}
