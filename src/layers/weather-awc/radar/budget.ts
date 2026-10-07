import type { RadarContours, RadarFile } from '@zlayer/contracts';

// Independent national/terminal reservations let national coverage remain usable
// when a broad terminal selection exceeds admission. Renderer copies are extra.
export const RADAR_SELECTED_BYTES = 32 * 1024 * 1024;
export const RADAR_NATIONAL_WEIGHT = 96 * 1024 * 1024;
export const RADAR_TERMINAL_WEIGHT = 32 * 1024 * 1024;
export const RADAR_TERMINAL_LIMIT = 'Terminal radar unavailable: selected coverage exceeds the memory limit. Zoom in to reduce coverage.';

/** Conservative geometry allocation weight; not an exact JS/GPU heap measurement. */
export function radarWeight(scan: RadarContours, file: RadarFile): number {
  let weight = file.byteLength * 2;
  for (const feature of scan.features) for (const polygon of feature.geometry.coordinates) {
    weight += 256; // Polygon array plus display feature/geometry wrapper.
    for (const ring of polygon) weight += 64 + ring.length * 64;
  }
  return weight;
}
