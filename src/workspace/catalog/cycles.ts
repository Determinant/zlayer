import { isIsoDate, isRecord } from '@zlayer/contracts';
import { readOfflineRecord, writeOfflineRecord } from '../../core/storage/database';
import { chartRoot } from './feed';

export type CycleSelection = 'latest' | string;
export type ChartCycleIndex = { revisions: string[]; rasterRevisions: string[] | undefined };

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
  return parseChartCycleIndex(value).revisions;
}

export function parseChartCycleIndex(value: unknown): ChartCycleIndex {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.cycles) ||
    !value.cycles.every(isIsoDate)) throw new Error('Invalid FAA cycle index');
  const cycles = value.cycles;
  if (value.rasterCycles !== undefined && (!Array.isArray(value.rasterCycles) ||
    !value.rasterCycles.every(date => isIsoDate(date) && cycles.includes(date)))) {
    throw new Error('Invalid FAA raster cycle index');
  }
  return { revisions: [...new Set(cycles.filter(isSupportedCycle))].sort().reverse(),
    rasterRevisions: value.rasterCycles === undefined ? undefined
      : [...new Set(value.rasterCycles.filter(isSupportedCycle))].sort().reverse() };
}

export async function fetchChartCycles(signal?: AbortSignal): Promise<ChartCycleIndex & { stale: boolean }> {
  const root = chartRoot();
  const key = `catalog-cycles:${root}`;
  try {
    const response = await fetch(`${root}/cycles.json`, { cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`FAA cycle list unavailable (${response.status})`);
    const index = parseChartCycleIndex(await response.json());
    if (!index.revisions.length) throw new Error('No supported FAA cycles are published');
    signal?.throwIfAborted();
    await writeOfflineRecord(key, index.rasterRevisions === undefined ? index.revisions
      : { schemaVersion: 1, cycles: index.revisions, rasterCycles: index.rasterRevisions }).catch(() => {});
    return { ...index, stale: false };
  } catch (error) {
    signal?.throwIfAborted();
    const cached = await readOfflineRecord(key).catch(() => undefined);
    try {
      const index = parseChartCycleIndex(Array.isArray(cached) ? { schemaVersion: 1, cycles: cached } : cached);
      if (index.revisions.length) return { ...index, stale: true };
    } catch { /* Only validated discovery can guide offline selection. */ }
    throw error;
  }
}
