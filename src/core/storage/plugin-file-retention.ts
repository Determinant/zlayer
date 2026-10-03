export type FileRetention = { group: string; cohort?: string; keep?: readonly string[] };
export type FileLimits = { maxEntries: number; maxBytes: number; maxUnusedMs: number };
/** The default pool and optional independent category pools share one publication lock. */
export type PluginFileBudget = FileLimits & {
  /** Named pools have separate ceilings and cannot evict one another. Limits are additive. */
  groups?: Readonly<Record<string, FileLimits>>;
  /** Older browsing caches owned by this plugin, with their original per-file ceiling. */
  legacyCaches?: Readonly<Record<string, number>>;
};
export type MigrationSource = { cache: string; key: string };
export type RetentionEntry = { stores: { name: string }; key: { url: string }; bytes: number;
  used: number; sequence: number; group: string | undefined; cohort: string | undefined };

export function fileGroupLimits(budget: PluginFileBudget | undefined, group: string | undefined) {
  return group !== undefined && budget?.groups && Object.hasOwn(budget.groups, group) ? budget.groups[group] : undefined;
}

/** Decide against one ordered inventory; the caller owns locks and mutations. */
export function planFileRetention<Entry extends RetentionEntry>(entries: readonly Entry[],
  cacheName: string, policy: FileLimits, budget: PluginFileBudget | undefined,
  key: string, bytes: number, now: number, retention?: FileRetention, protectedLegacy?: MigrationSource) {
  const groupLimits = (group: string | undefined) => fileGroupLimits(budget, group);
  const sequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1;
  const limits = retention ? groupLimits(retention.group)! : budget;
  const keep = new Set(retention?.keep);
  const protectedFile = (entry: Entry) => entry.stores.name === cacheName && keep.has(entry.key.url);
  // Unknown/older categories stay in the bounded default pool. A category's
  // reads, writes and quota recovery never remove another category's files.
  const others = entries.filter(entry => (entry.stores.name !== cacheName || entry.key.url !== key) &&
    (retention ? entry.group === retention.group : !groupLimits(entry.group)));
  let total = others.reduce((sum, entry) => sum + entry.bytes, bytes), count = others.length + 1;
  let localBytes = others.filter(entry => entry.stores.name === cacheName).reduce((sum, entry) => sum + entry.bytes, bytes);
  let localCount = others.filter(entry => entry.stores.name === cacheName).length + 1;
  const retained: Entry[] = [], removals: Entry[] = [];
  for (const entry of others) {
    if (protectedLegacy && entry.stores.name === protectedLegacy.cache && entry.key.url === protectedLegacy.key) continue;
    if (protectedFile(entry) || retention?.cohort && entry.cohort === retention.cohort) continue;
    const local = entry.stores.name === cacheName;
    if (now - entry.used > (local ? Math.min(policy.maxUnusedMs, limits?.maxUnusedMs ?? Infinity) : limits!.maxUnusedMs)
      || local && (localBytes > policy.maxBytes || localCount > policy.maxEntries)
      || limits && (total > limits.maxBytes || count > limits.maxEntries)) {
      removals.push(entry); total -= entry.bytes; count--;
      if (local) { localBytes -= entry.bytes; localCount--; }
    } else retained.push(entry);
  }
  // A protected migration source stays intact if both copies cannot fit.
  const fits = localBytes <= policy.maxBytes && localCount <= policy.maxEntries &&
    (!limits || total <= limits.maxBytes && count <= limits.maxEntries);
  // Category saves may reclaim disposable/default files on actual browser
  // quota pressure, but no category is a victim of another category.
  const disposable = retention ? entries.filter(entry => !groupLimits(entry.group) &&
    (entry.stores.name !== cacheName || entry.key.url !== key) &&
    !protectedFile(entry) &&
    !(protectedLegacy && entry.stores.name === protectedLegacy.cache && entry.key.url === protectedLegacy.key)) : [];
  return { removals, victims: [...disposable, ...retained], sequence, fits };
}
