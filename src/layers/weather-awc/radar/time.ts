import { RADAR_MAX_AGE, RADAR_HISTORY_MS, type RadarCatalog, type RadarFile } from '@zlayer/contracts';
export function radarTimes(catalog: RadarCatalog | undefined, now: number): number[] {
  return [...new Set([...(catalog?.history ?? []), ...(catalog?.files ?? [])]
    .filter(f => f.site === 'CONUS' && f.observedAt <= now && now - f.observedAt < RADAR_HISTORY_MS)
    .map(f => f.observedAt))].sort((a, b) => a - b);
}
/** Observations at or before the selected instant, never a later terminal scan
 * mixed into an older national image. Age at the selected instant bounds gaps. */
export function currentRadar(catalog: RadarCatalog | undefined, selectedTime: number | null, now: number) {
  const time = selectedTime ?? now;
  if (time > now || now - time >= RADAR_HISTORY_MS) return [];
  const chosen = new Map<string, RadarFile>();
  for (const file of [...(catalog?.history ?? []), ...(catalog?.files ?? [])]) {
    if (file.observedAt > time || time - file.observedAt >= RADAR_MAX_AGE || now - file.observedAt >= RADAR_HISTORY_MS) continue;
    if (!chosen.has(file.site) || chosen.get(file.site)!.observedAt <= file.observedAt) chosen.set(file.site, file);
  }
  return chosen.has('CONUS') ? [...chosen.values()].sort((a, b) => a.site.localeCompare(b.site)) : [];
}
