import { createPluginStorage } from '../../core/storage/plugin-storage';

export const pluginStorage = createPluginStorage('ahrs',
  name => name === 'ahrs-mount' || name === 'ahrs-fullscreen' ? `zlayer-ui:${name}` : undefined);
