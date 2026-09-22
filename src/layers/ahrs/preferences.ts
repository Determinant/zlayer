import { pluginStorage } from './storage';
import { isBoolean } from '../../core/storage/ui-state';
import type { Mount } from './estimator/device-frame';
export const ahrsMount = pluginStorage.ui<Mount>('ahrs-mount', 'upright', (value): value is Mount => value === 'upright' || value === 'flat');
export const ahrsFullscreen = pluginStorage.ui('ahrs-fullscreen', false, isBoolean);
