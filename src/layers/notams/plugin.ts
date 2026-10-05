import type { LayerPlugin } from '../../core/layers/plugin';
import type { PluginExports } from '../../core/layers/bridge';
import type { NotamsApi } from './public';
import { createNotamsClient } from './client';
import { pluginStorage } from './storage';

export function createNotamsPlugin() {
  const client = createNotamsClient();
  return {
    definition: { id: 'notams', title: 'NOTAMs' }, storage: pluginStorage,
    publicApi(scope) {
      client.start(); scope.add(client.stop);
      return { state: scope.store(client.state), retain: scope.command((query, online) => scope.add(client.retain(query, online))),
        retry: scope.command(client.retry) };
    },
    dispose: client.stop,
  } satisfies LayerPlugin & PluginExports<NotamsApi>;
}
