import type { MapContextAction } from '../../core/map/selection';

export type WeatherAwcApi = { contextActions(point: { x: number; y: number }): MapContextAction[] };
