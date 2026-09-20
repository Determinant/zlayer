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
    let stopped = false, generation = 0;
    const refresh = () => {
      const attempt = ++generation;
      const publish = (inventory: SavedBundleInventory) => {
        if (stopped || generation !== attempt) return;
        setState(previous => {
          const restored = retainFailedBundleOwnership(inventory, previous.bundles);
          const same = previous.bundles.length === restored.length && previous.bundles.every((bundle, index) =>
            bundle.key === restored[index]?.key && bundle.unavailable === restored[index]?.unavailable);
          const error = inventory.issues.length ? `Saved regions could not be verified: ${inventory.issues.map(issue => issue.message).join('; ')}` : undefined;
          if (previous.ready && same && previous.error === error) return previous;
          return { bundles: same ? previous.bundles : restored, ready: true, error };
        });
      };
      void restoreSavedBundleMetadata().then(async inventory => {
        if (stopped || generation !== attempt) return;
        publish(inventory);
        const checked = await checkSavedBundleAvailability(inventory.bundles);
        publish({ bundles: checked.bundles, issues: [...inventory.issues, ...checked.issues] });
      }).catch(error => {
        if (!stopped && generation === attempt) setState(previous => ({ ...previous, ready: true,
          error: `Saved regions could not be verified: ${error instanceof Error ? error.message : 'Storage unavailable'}` }));
      });
    };
    refresh();
    const stop = observeOfflineInventory(refresh);
    return () => { stopped = true; stop(); };
  }, []);
  const resolved = useMemo(() => {
    if (!browsing || !state.ready) return undefined;
    return createWorkspaceReadContext(browsing, state.bundles);
  }, [browsing, state.bundles, state.ready]);
  const missing = state.bundles.filter(bundle => bundle.unavailable);
  const availability = missing.length ? `Saved files are missing for ${missing.map(bundle =>
    `${bundle.plan.title} · ${formatDate(bundle.plan.revision)}`).join(', ')}. Their saved editions remain selected; use Settings to repair.` : undefined;
  return { context: resolved, bundles: state.bundles, error: state.error ?? availability };
}
