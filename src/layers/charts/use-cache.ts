import { useCallback, useEffect, useState } from 'react';

import type { ChartRecord } from '@zlayer/contracts';

import { preparePwa } from '../../pwa';
import { isResourceErrorCode, type ResourceErrorCode } from '../../core/data/errors';

export type ChartCacheState = 'preparing' | 'ready' | 'unavailable';

const PREPARATION_RETRY_DELAYS = [1_000, 3_000, 10_000];

export function useChartCache(charts: readonly ChartRecord[] | undefined, onError: (message: string, code?: ResourceErrorCode) => void, active = true): {
  state: ChartCacheState;
  retry: () => void;
} {
  const [state, setState] = useState<ChartCacheState>('preparing');
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    // Reconnecting or adopting a new worker must not hide already working charts.
    setState(current => current === 'ready' ? current : 'preparing');
    const prepare = async () => {
      const available = await preparePwa();
      if (cancelled) return;
      if (available) { setState('ready'); return; }
      const delay = PREPARATION_RETRY_DELAYS[failures++];
      // A slow install or failed readiness handshake can finish without another
      // controllerchange. Recover on this page, but bound persistent failures.
      if (navigator.serviceWorker && delay !== undefined) timer = setTimeout(() => { void prepare(); }, delay);
      else setState('unavailable');
    };

    navigator.serviceWorker?.addEventListener('controllerchange', retry);
    window.addEventListener('online', retry);
    void prepare();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      navigator.serviceWorker?.removeEventListener('controllerchange', retry);
      window.removeEventListener('online', retry);
    };
  }, [active, attempt, retry]);

  // Updating catalog metadata or error handlers must not restart preparation
  // and briefly hide chart sources that are already ready.
  useEffect(() => {
    if (!active) return;
    const receiveMessage = (event: MessageEvent<unknown>) => {
      if (!isChartArchiveErrorMessage(event.data)) return;
      const message = event.data;
      const chart = charts?.find((candidate) => candidate.url === message.url);
      onError(`${chart?.title ?? 'Chart archive'} could not be cached: ${message.message}`, message.code);
    };

    navigator.serviceWorker?.addEventListener('message', receiveMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', receiveMessage);
    };
  }, [active, charts, onError]);

  return { state, retry };
}

function isChartArchiveErrorMessage(
  value: unknown,
): value is { type: 'chart-archive-error'; url: string; message: string; code?: ResourceErrorCode } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.type === 'chart-archive-error' &&
    typeof message.url === 'string' &&
    typeof message.message === 'string' && (message.code === undefined || isResourceErrorCode(message.code));
}
