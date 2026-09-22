import type { PluginConnectionRecovery } from '../core/layers/bridge';
import type { LayerPlugin } from '../core/layers/plugin';
import { useLayerSnapshot } from '../core/layers/use-snapshot';

export function WorkspaceConnectionNotice({ connections, plugins }: {
  connections: PluginConnectionRecovery; plugins: readonly LayerPlugin[];
}) {
  const failures = useLayerSnapshot(connections.failures);
  if (!failures.length) return null;
  const title = (id: string) => plugins.find(plugin => plugin.definition.id === id)?.definition.title ?? id;
  return <div className="map-runtime-error" role="alert">
    <strong>Workspace connection unavailable</strong>
    <span>{failures.map(failure => `${title(failure.providerId)}: ${failure.message}`).join('; ')}</span>
    <button className="ui-button" type="button" onClick={connections.retryFailed}>Retry workspace connections</button>
  </div>;
}
