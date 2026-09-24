import type { SurfaceFeature } from '@zlayer/contracts';

export const SURFACE_COLORS = { HIGH: '#0057b8', LOW: '#c2183a', COLD: '#0057b8', WARM: '#c2183a', STNRY: '#0057b8',
  OCFNT: '#7924a3', TROF: '#a84800', DRYLINE: '#a84800', SQUALL: '#c2183a', ISOBAR: '#676767', LABEL: '#555555',
  HURRICANE: '#c2183a', TROPICAL_STORM: '#c2183a' };
export const SURFACE_LABELS = { HIGH: 'High pressure', LOW: 'Low pressure', COLD: 'Cold front', WARM: 'Warm front',
  STNRY: 'Stationary front', OCFNT: 'Occluded front', TROF: 'Trough', DRYLINE: 'Dry line', SQUALL: 'Squall line',
  ISOBAR: 'Isobar', LABEL: 'Chart label', HURRICANE: 'Hurricane', TROPICAL_STORM: 'Tropical storm' };

/** NOAA numeric pressure text is separate from both contour and center geometry. */
export const isSurfacePressureLabel = (feature: SurfaceFeature) => feature.kind === 'LABEL' && /^\d{3,4}$/.test(feature.text);
