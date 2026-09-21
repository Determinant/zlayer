import type { LineLayerSpecification } from 'maplibre-gl';

/** Shared by temporary ruler and navaid-ID connections over busy chart imagery. */
export const REFERENCE_LINE_COLOR = '#005a9c';
export const REFERENCE_LINE_HALO: Pick<LineLayerSpecification, 'layout' | 'paint'> = {
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: { 'line-color': '#ffffff', 'line-opacity': 1, 'line-width': 6 },
};
export const REFERENCE_LINE_PAINT: NonNullable<LineLayerSpecification['paint']> = {
  'line-color': REFERENCE_LINE_COLOR, 'line-width': 2, 'line-dasharray': [4, 2],
};
