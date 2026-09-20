import { VFR_WAYPOINT_MIN_ZOOM } from '../navigation/definitions';

// Display prominence is AGL, independent of the top elevation used by labels.
// Keep the close-view floor at 500 ft; taller structures survive wider views.
export const OBSTRUCTION_ZOOM_TIERS = [
  { minZoom: VFR_WAYPOINT_MIN_ZOOM - 3, minHeightAglFt: 2000 },
  { minZoom: VFR_WAYPOINT_MIN_ZOOM - 2, minHeightAglFt: 1500 },
  { minZoom: VFR_WAYPOINT_MIN_ZOOM - 1, minHeightAglFt: 1000 },
  { minZoom: VFR_WAYPOINT_MIN_ZOOM, minHeightAglFt: 500 },
] as const;
export const OBSTRUCTION_MIN_ZOOM = OBSTRUCTION_ZOOM_TIERS[0].minZoom;
export const OBSTRUCTION_SOURCE = 'route-obstructions';
export const OBSTRUCTION_LAYER = 'route-obstruction-symbols';
export const OBSTRUCTION_COLOR = '#ea92dd';

export function obstructionMinZoom(heightAglFt: number): number | undefined {
  return OBSTRUCTION_ZOOM_TIERS.find(tier => heightAglFt >= tier.minHeightAglFt)?.minZoom;
}

export function obstructionMinHeight(zoom: number): number | undefined {
  let height: number | undefined;
  for (const tier of OBSTRUCTION_ZOOM_TIERS) if (zoom >= tier.minZoom) height = tier.minHeightAglFt;
  return height;
}

export function obstructionIcon(heightAglFt: number, quantity: number, lightingCode: string, structureType: string): string {
  const shape = /^WIND(?:MILL| TURBINE)/i.test(structureType) ? 'wind' : heightAglFt >= 1000 ? 'tall' : 'low';
  // FAA DOF H/S are high-intensity strobes. Ordinary red/medium/unknown
  // lighting must not acquire the chart's high-intensity starburst.
  const light = lightingCode === 'H' || lightingCode === 'S' ? 'strobe' : 'plain';
  return `obstruction-${shape}-${quantity > 1 ? 'group' : 'single'}-${light}`;
}

export const OBSTRUCTION_ICONS = ['low', 'tall', 'wind'].flatMap(shape =>
  ['single', 'group'].flatMap(group => ['plain', 'strobe'].map(light => `obstruction-${shape}-${group}-${light}`)));
