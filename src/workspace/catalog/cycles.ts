import { isIsoDate, isRecord } from '@zlayer/contracts';
import { readOfflineRecord, writeOfflineRecord } from '../../core/storage/database';
import { chartRoot } from './feed';

export type CycleSelection = 'latest' | string;

// This directory predates the ZLayer feeds and cannot be consumed by the app.
export function isSupportedCycle(value: unknown): value is string {
  return isIsoDate(value) && value > '2026-07-09';
}

export function defaultCycleSelection(): CycleSelection {
  const value = import.meta.env?.VITE_ZLAYERS_CHART_REVISION?.trim();
  if (!value || value === 'latest') return 'latest';
  if (!isSupportedCycle(value)) throw new Error('VITE_ZLAYERS_CHART_REVISION must be latest or a supported ISO date after 2026-07-09');
  return value;
}

export function parseChartCycles(value: unknown): string[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.cycles) ||
    !value.cycles.every(isIsoDate)) throw new Error('Invalid FAA cycle index');
  return [...new Set(value.cycles.filter(isSupportedCycle))].sort().reverse();
}

export async function fetchChartCycles(signal?: AbortSignal): Promise<{ revisions: string[]; stale: boolean }> {
  const root = chartRoot();
  const key = `catalog-cycles:${root}`;
  try {
    const response = await fetch(`${root}/cycles.json`, { cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`FAA cycle list unavailable (${response.status})`);
    const revisions = parseChartCycles(await response.json());
    if (!revisions.length) throw new Error('No supported FAA cycles are published');
    signal?.throwIfAborted();
    await writeOfflineRecord(key, revisions).catch(() => {});
    return { revisions, stale: false };
  } catch (error) {
    signal?.throwIfAborted();
    const cached = await readOfflineRecord(key).catch(() => undefined);
    if (Array.isArray(cached) && cached.length && cached.every(isSupportedCycle)) {
      return { revisions: [...new Set(cached)].sort().reverse(), stale: true };
    }
    throw error;
  }
}
