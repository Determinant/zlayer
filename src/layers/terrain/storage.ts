import { createPluginStorage } from '../../core/storage/plugin-storage';

export const pluginStorage = createPluginStorage('terrain',
  name => name === 'terrain-last-altitude' ? `zlayer-ui:${name}` : undefined);
