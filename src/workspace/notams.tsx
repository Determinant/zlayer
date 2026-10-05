import { useEffect, useState } from 'react';
import { PluginScope, type PluginRegistry } from '../core/layers/bridge';
import { createLayerStore } from '../core/layers/store';
import type { WorkspacePluginApis } from './plugin-apis';
import type { NotamsApi } from '../layers/notams/public';
import { PlateNotams } from '../layers/notams/ui';
import { PlateNoticeContextLoader, type PlateNoticeProps } from '../layers/plates/notice-context';

/** The workspace composes optional feature UI; neither plugin imports the other's components. */
export function useNotamsApi(registry: PluginRegistry<WorkspacePluginApis>): NotamsApi | undefined {
  const [api, setApi] = useState<NotamsApi>();
  useEffect(() => {
    const scope = new PluginScope();
    registry.forScope(scope).watch('notams', (provider, connection) => {
      if (!provider) { setApi(undefined); return; }
      const state = createLayerStore(provider.state.getSnapshot());
      connection.observe(provider.state, state.publish);
      setApi({ state, retain: (query, online) => connection.signal.aborted ? () => {} : provider.retain(query, online),
        retry: () => { if (!connection.signal.aborted) provider.retry(); } });
    });
    return () => scope.dispose();
  }, [registry]);
  return api;
}
export function WorkspacePlateNotices({ registry, ...props }: PlateNoticeProps & {
  registry: PluginRegistry<WorkspacePluginApis>;
}) {
  const api = useNotamsApi(registry);
  return api ? <PlateNoticeContextLoader {...props}>{(context, retryCatalog) =>
    <PlateNotams api={api} context={context} active={props.active} retryCatalog={retryCatalog} />}</PlateNoticeContextLoader> : null;
}
