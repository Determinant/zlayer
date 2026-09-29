import { createPluginStorage } from '../../core/storage/plugin-storage';

export const pluginStorage = createPluginStorage('navigation',
  name => name.startsWith('feature-tab:') ? `zlayer-ui:${name}` : undefined,
  { uiRetention: [{ prefix: 'feature-tab:', limit: 128 }] });
