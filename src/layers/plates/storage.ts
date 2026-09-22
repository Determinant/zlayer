import { createPluginStorage } from '../../core/storage/plugin-storage';

export const pluginStorage = createPluginStorage('plates',
  name => name === 'plate-selection' || name === 'plate-on-map' || name.startsWith('plate-view:') ? `zlayer-ui:${name}` : undefined);
