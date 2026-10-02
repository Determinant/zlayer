import type { MapContextAction } from '../../core/map/selection';
/** Optional map menu actions; selection belongs to Glide's current session. */
export type GlideApi = { contextActions(point: { x: number; y: number }): MapContextAction[] };
