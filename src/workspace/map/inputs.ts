import type { Bounds } from '@zlayer/contracts';
import type { ResourceErrorCode } from '../../core/data/errors';
import type { MapContribution } from '../../core/map/contribution';
import type { MapView } from './style';
import type { OrientationSource } from './navigation-control';
export type MapCallbacks = {
  onViewportChange(bounds: Bounds): void;
  onViewChange?(view: MapView): void;
  onReady(): void;
  onIdleChange?: ((idle: boolean) => void) | undefined;
  onStartupFailure?: (() => void) | undefined;
  onError(message: string, code?: ResourceErrorCode): void;
};
export type MapAttachment = { contributions: readonly MapContribution[]; orientation: OrientationSource };
