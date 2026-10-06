import type { NotamRecord } from '@zlayer/contracts';
import { notamTime } from '../../../src/layers/notams/validity';

export const NOTAM_DAY_MS = 86_400_000;
// One daily allowance plus time to download, bridge and publish. This is an
// operational warning, independent of continuity of the ongoing delta stream.
export const NOTAM_FULL_SYNC_MAX_AGE = NOTAM_DAY_MS + 10 * 60_000;

/** Cancellation may occur without advancing lastUpdated. Keep its evidence
 * through replay and full replacement without changing source revision order. */
export function notamCancellationExpiresAt(record: NotamRecord): number | undefined {
  if (record.lifecycle !== 'cancelled' && record.lifecycle !== 'cancellation') return undefined;
  return Math.max(record.updatedAt, notamTime(record.canceledAt) ?? 0) + 2 * NOTAM_DAY_MS;
}
