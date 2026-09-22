import { createPluginStorage } from '../../core/storage/plugin-storage';

export const pluginStorage = createPluginStorage('routes',
  name => name === 'route-summary-open' || name === 'recommendations-open' || name.startsWith('recommendation-') ? `zlayer-ui:${name}` : undefined);
