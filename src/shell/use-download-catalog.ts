import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogResponse } from '@zlayer/contracts';
import { fetchLatestDownloadCatalog } from '../workspace/catalog/catalog';
import { fetchOfflinePlateIndex, type OfflinePlateIndex } from '../layers/plates';
import { useOnline } from '../core/use-online';

type DownloadCatalog = { catalog: CatalogResponse; index: OfflinePlateIndex };

/** One refresh owns discovery and book indexes for both the list and Update.
 * Browsing can be pinned; downloads always discover the latest effective cycle. */
export function useDownloadCatalog(browsing: CatalogResponse, open: boolean) {
  const online = useOnline();
  const pending = useRef<{ controller: AbortController; request: Promise<DownloadCatalog> } | undefined>(undefined);
  const previous = useRef<{ identity: string; value: DownloadCatalog } | undefined>(undefined);
  const [state, setState] = useState<{
    catalog: CatalogResponse; index?: OfflinePlateIndex; checking: boolean; error?: string | undefined;
  }>({ catalog: browsing, checking: true });
  const refresh = useCallback((): Promise<DownloadCatalog> => {
    if (pending.current && !pending.current.controller.signal.aborted) return pending.current.request;
    const controller = new AbortController();
    setState(state => ({ ...state, checking: true, error: undefined }));
    const request = (async () => {
      const catalog = await fetchLatestDownloadCatalog(controller.signal);
      const index = await fetchOfflinePlateIndex(catalog, true);
      controller.signal.throwIfAborted();
      // Immutable loaders reuse their parsed exports. Compare mutable metadata
      // by contents, never only timestamps, so a no-change check keeps prepared plans.
      const identity = JSON.stringify([catalog, index.supplements]);
      const old = previous.current;
      const value = old?.identity === identity && old.value.index.airports === index.airports &&
        old.value.index.procedures === index.procedures ? old.value : { catalog, index };
      previous.current = { identity, value };
      setState({ ...value, checking: false });
      return value;
    })().catch(error => {
      if (!controller.signal.aborted) setState(state => ({ ...state, checking: false,
        error: error instanceof Error ? error.message : 'Could not check for updates.' }));
      throw error;
    }).finally(() => { if (pending.current?.request === request) pending.current = undefined; });
    pending.current = { controller, request };
    return request;
  }, []);
  useEffect(() => () => pending.current?.controller.abort(), []);
  useEffect(() => {
    if (open) void refresh().catch(() => {});
    // Unchanged browsing refreshes must not launch a second discovery pipeline.
  }, [open, online, browsing.revision, refresh]);
  return { ...state, online, refresh };
}
