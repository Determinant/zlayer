import { normalizeIdentifier } from '@zlayer/domain';

export const METAR_STATIONS_PER_REQUEST = 100;
export const METAR_LOOKBACK_HOURS = 2;

export function stationIdBatches(
  stationIds: readonly string[],
  batchSize = METAR_STATIONS_PER_REQUEST,
): string[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('METAR batch size must be a positive integer');
  }
  const normalizedIds = [...new Set(stationIds
    .map(normalizeIdentifier)
    .filter((station): station is string => station !== undefined))];
  const batches: string[][] = [];
  for (let offset = 0; offset < normalizedIds.length; offset += batchSize) {
    batches.push(normalizedIds.slice(offset, offset + batchSize));
  }
  return batches;
}
