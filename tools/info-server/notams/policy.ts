export const NOTAM_DAY_MS = 86_400_000;
// One daily allowance plus time to download, bridge and publish. This is an
// operational warning, independent of continuity of the ongoing delta stream.
export const NOTAM_FULL_SYNC_MAX_AGE = NOTAM_DAY_MS + 10 * 60_000;
