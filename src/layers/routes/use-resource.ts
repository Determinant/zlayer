import { useEffect, useState } from 'react';
import { useOnline } from '../../core/use-online';
import { useInventoryVersion } from '../../offline/use-inventory-version';

/** Immutable route references and queries share recovery and stale-result rules.
 * The key includes the complete resource identity, edition and query. Undefined
 * disables demand; cancelling a view never cancels a shared reference download. */
export function useRouteResource<T>(key: string | undefined, load: (signal: AbortSignal) => Promise<T>) {
  const online = useOnline();
  const inventoryVersion = useInventoryVersion();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>();

  useEffect(() => {
    if (key === undefined) { setResult(undefined); return; }
    const controller = new AbortController();
    // Keep usable data during same-source recovery, including the current preview.
    setResult(current => current?.key === key && current.data !== undefined ? { key, data: current.data } : { key });
    const request = async () => load(controller.signal);
    void request().then(data => {
      if (!controller.signal.aborted) setResult({ key, data });
    }).catch(reason => {
      if (!controller.signal.aborted) setResult(current => ({ key,
        ...(current?.key === key && current.data !== undefined ? { data: current.data } : {}),
        error: reason instanceof Error ? reason.message : 'Route data unavailable',
      }));
    });
    return () => controller.abort();
    // Callers provide an inline loader; its complete identity is represented by key.
  }, [key, attempt, online, inventoryVersion]);

  const current = key !== undefined && result?.key === key ? result : undefined;
  return { data: current?.data, error: current?.error,
    loading: key !== undefined && current?.data === undefined && current?.error === undefined,
    retry: () => setAttempt(value => value + 1) };
}
