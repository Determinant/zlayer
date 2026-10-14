import type { MapContextAction } from '../../core/map/selection';

export type WeatherAwcApi = { primaryAction?(point: { x: number; y: number }): MapContextAction | undefined; contextActions(point: { x: number; y: number }): MapContextAction[] };
