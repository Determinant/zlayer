import { RADAR_MAX_AGE, RADAR_HISTORY_MS, type RadarMotionCatalog, type RadarMotionScan } from '@zlayer/contracts';

export function motionFile(catalog: RadarMotionCatalog | undefined, selected: number | null, now: number) {
  const target = selected ?? now;
  if (target > now || now - target >= RADAR_HISTORY_MS) return undefined;
  return catalog?.files.filter(f => f.availableAt <= target && now - f.availableAt < RADAR_HISTORY_MS)
    .sort((a, b) => b.availableAt - a.availableAt)[0];
}
/** Match the displayed composite time, not merely the toolbox's Now label. */
export function motionScans(scans: RadarMotionScan[], compositeTime: number, now: number): RadarMotionScan[] {
  return scans.filter(s => s.observedAt <= compositeTime && compositeTime - s.observedAt < RADAR_MAX_AGE && now - s.observedAt < RADAR_HISTORY_MS);
}
