import { useEffect, useMemo, useState } from 'react';
import { formatDate } from '../core/format/time';
import type { ChartCatalog } from './catalog/catalog';
import { createWorkspaceReadContext } from './read-context';
import { restoreSavedBundleMetadata, checkSavedBundleAvailability, retainFailedBundleOwnership,
  type SavedBundle, type SavedBundleInventory } from '../offline/bundle-repository';
import { observeOfflineInventory } from '../offline/inventory-events';

export function useWorkspaceReadContext(browsing: ChartCatalog | undefined) {
  const [state, setState] = useState<{ bundles: SavedBundle[]; ready: boolean; error?: string | undefined }>({ bundles: [], ready: false });
  useEffect(() => {
    let stopped = false, generation = 0, restoring = false, checking = false;
    let controller: AbortController | undefined;
    let pendingHealth: { inventory: SavedBundleInventory; signal: AbortSignal } | undefined;
    const publish = (inventory: SavedBundleInventory) => {
      setState(previous => {
        const restored = retainFailedBundleOwnership(inventory, previous.bundles);
        const same = previous.bundles.length === restored.length && previous.bundles.every((bundle, index) =>
          bundle.key === restored[index]?.key && bundle.unavailable === restored[index]?.unavailable);
        const error = inventory.issues.length ? `Saved regions could not be verified: ${inventory.issues.map(issue => issue.message).join('; ')}` : undefined;
        if (previous.ready && same && previous.error === error) return previous;
        return { bundles: same ? previous.bundles : restored, ready: true, error };
      });
    };
    const report = (error: unknown, signal: AbortSignal) => {
      if (!signal.aborted) setState(previous => ({ ...previous, ready: true,
        error: `Saved regions could not be verified: ${error instanceof Error ? error.message : 'Storage unavailable'}` }));
    };
    const checkHealth = async () => {
      if (checking) return;
      checking = true;
      try {
        while (!stopped && pendingHealth) {
          const { inventory, signal } = pendingHealth;
          pendingHealth = undefined;
          try {
            signal.throwIfAborted();
            const checked = await checkSavedBundleAvailability(inventory.bundles, signal);
            signal.throwIfAborted();
            publish({ bundles: checked.bundles, issues: [...inventory.issues, ...checked.issues] });
          } catch (error) { report(error, signal); }
        }
      } finally { checking = false; }
    };
    const refresh = async () => {
      generation++;
      controller?.abort();
      if (restoring) return;
      restoring = true;
      try {
        let attempt: number;
        do {
          // Coalesce synchronous notifications before opening IndexedDB.
          await Promise.resolve();
          if (stopped) return;
          attempt = generation;
          controller = new AbortController();
          const { signal } = controller;
          try {
            const inventory = await restoreSavedBundleMetadata(signal);
            signal.throwIfAborted();
            publish(inventory);
            // Selection changes never wait behind a slow health read. Keep only
            // the newest pending health check; admitted reads finish serially.
            pendingHealth = { inventory, signal };
            void checkHealth();
          } catch (error) { report(error, signal); }
        } while (!stopped && generation !== attempt);
      } finally { restoring = false; }
    };
    const stop = observeOfflineInventory(() => { void refresh(); });
    void refresh();
    return () => { stopped = true; controller?.abort(); pendingHealth = undefined; stop(); };
  }, []);
  const resolved = useMemo(() => {
    if (!state.ready) return undefined;
    const catalog = browsing ?? state.bundles[0]?.catalog;
    return catalog ? createWorkspaceReadContext(catalog, state.bundles) : undefined;
  }, [browsing, state.bundles, state.ready]);
  const missing = state.bundles.filter(bundle => bundle.unavailable);
  const availability = missing.length ? `Saved files are missing for ${missing.map(bundle =>
    `${bundle.plan.title} · ${formatDate(bundle.plan.revision)}`).join(', ')}. Their saved editions remain selected; use Settings to repair.` : undefined;
  return { context: resolved, bundles: state.bundles, ready: state.ready, error: state.error ?? availability };
}
