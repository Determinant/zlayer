import { useEffect, useState } from 'react';
import { formatDate } from '../../core/format/time';

import { fetchChartCatalog, type ChartCatalog } from './catalog';
import { fetchChartCycles, isSupportedCycle, type CycleSelection } from './cycles';
import { savedCatalogs, saveCatalog, retainCachedProducts, hasCatalogData, selectSavedCycle } from './saved-catalog';
import { preparePwa } from '../../pwa';
import { retainActiveCatalog } from '../../offline/active-catalogs';
import { pruneOnlineCache } from '../../offline/cache-cleanup';

type CatalogState = {
  catalogs: ChartCatalog[];
  revisions: string[];
  selection: CycleSelection;
  catalog?: ChartCatalog;
  ready: boolean;
  stale?: boolean;
  loadingCycle?: string | undefined;
  error?: string | undefined;
};

export function useCatalog() {
  const [state, setState] = useState<CatalogState>({ catalogs: [], revisions: [], selection: 'latest', ready: false });
  const [requested, setRequested] = useState<{ selection: CycleSelection }>();

  useEffect(() => {
    if (!state.catalog) return;
    return retainActiveCatalog(state.catalog);
  }, [state.catalog]);

  useEffect(() => {
    if (!state.catalog || !state.ready || state.stale) return;
    const timer = setTimeout(() => { void pruneOnlineCache([state.catalog!]).catch(() => {}); }, 5_000);
    return () => clearTimeout(timer);
  }, [state.catalog, state.ready, state.stale]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const saved = await savedCatalogs();
      if (controller.signal.aborted) return;
      setState(current => ({ ...current, ...saved }));
      const discovered = await fetchChartCycles(controller.signal).catch(error => {
        controller.signal.throwIfAborted();
        if (!saved.catalog && saved.selection === 'latest') throw error;
        return { revisions: saved.catalogs.map(value => value.revision), stale: true };
      });
      if (!controller.signal.aborted) setState(current => ({ ...current, ...discovered, ready: true }));
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) setState(current => ({ ...current, error: errorMessage(error) }));
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!state.ready) return;
    const controller = new AbortController();
    const selection = requested?.selection ?? state.selection;
    const candidates = selection === 'latest' ? state.revisions : [selection];
    setState(current => ({ ...current, loadingCycle: selection, error: undefined }));
    const commit = (catalog: ChartCatalog) => {
      if (controller.signal.aborted) return;
      setState(current => ({ ...current, catalog, selection, loadingCycle: undefined,
        catalogs: [catalog, ...current.catalogs.filter(value => value.revision !== catalog.revision)]
          .sort((a, b) => b.revision.localeCompare(a.revision)),
      }));
      void selectSavedCycle(selection).catch(() => {});
      void saveCatalog(catalog).catch(() => {});
    };
    // A downloaded edition is usable immediately, including without a network.
    const saved = state.catalogs.find(value => value.revision === candidates[0]);
    if (saved) commit(saved);
    void (async () => {
      await preparePwa();
      controller.signal.throwIfAborted();
      for (const revision of candidates) {
        const cached = state.catalogs.find(value => value.revision === revision);
        const catalog = retainCachedProducts(await fetchChartCatalog(revision, controller.signal), cached);
        controller.signal.throwIfAborted();
        // A dated directory may be a partial upload. Require usable chart metadata
        // before automatically choosing it; keep any same-cycle saved products.
        if (catalog.charts.length || (cached && hasCatalogData(catalog))) {
          commit(catalog);
          return;
        }
      }
      throw new Error(`FAA cycle ${selection === 'latest' ? 'discovery' : formatDate(selection)} unavailable. Reconnect to load its charts.`);
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) setState(current => ({ ...current, loadingCycle: undefined, error: errorMessage(error) }));
    });
    return () => controller.abort();
    // Catalog writes must not restart revalidation. Only discovery or a user choice does.
  }, [state.ready, state.revisions, requested]);

  const selectCycle = (selection: CycleSelection) => {
    if (selection === 'latest' || (isSupportedCycle(selection) && cycles.includes(selection))) setRequested({ selection });
  };
  const cycles = [...new Set([...state.revisions, ...state.catalogs.map(value => value.revision),
    ...(isSupportedCycle(state.selection) ? [state.selection] : [])])].sort().reverse();
  const latest = state.revisions[0];
  const cycleNotice = [
    state.loadingCycle ? `Loading FAA cycle ${formatDate(state.loadingCycle)}…` : undefined,
    state.error,
    state.stale ? 'Cycle list unavailable online. Using saved editions; reconnect and reload to check for newer charts.' : undefined,
    state.catalog && ((latest && state.catalog.revision !== latest) ||
      (state.selection !== 'latest' && state.catalog.revision !== state.selection))
      ? `Using FAA cycle ${formatDate(state.catalog.revision)}.${latest ? ` Latest: ${formatDate(latest)}.` : ''} Download each cycle separately.` : undefined,
  ].filter(Boolean).join(' ') || undefined;
  // An evicted pinned catalog can fall back to another saved edition at launch.
  // The menu must label the actual map, even while retrying the saved preference.
  const selection = state.selection === 'latest' ? 'latest' : state.catalog?.revision ?? state.selection;
  return { ...state, selection, cycles, latest, selectCycle, cycleNotice };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load data catalog';
}
