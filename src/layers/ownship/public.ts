import type { LayerStore } from '../../core/layers/store';
import type { GpsSnapshot } from '../../core/gps/service';
/** Passive map-ownship observation; consumers do not acquire another GPS watch. */
export type OwnshipApi = { readonly position: LayerStore<GpsSnapshot & { enabled: boolean }> };
