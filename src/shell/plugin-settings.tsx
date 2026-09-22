import type { PluginControl } from '../core/layers/use-plugins';

export function PluginSettings({ plugins, onChange, error }: {
  plugins: readonly PluginControl[]; onChange(id: string, loaded: boolean): void; error?: string | undefined;
}) {
  const title = (id: string) => plugins.find(plugin => plugin.id === id)?.title ?? id;
  return <>
    <div><h3>Layer plugins</h3>
      <p>Enable or disable features without refreshing. Your choices are remembered; saved routes,
        preferences, and downloaded data are kept.</p></div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <ul className="plugin-list">
      {plugins.map(plugin => <li key={plugin.id} className="plugin-row" data-plugin={plugin.id}>
        <div><h4>{plugin.title}</h4>
          {plugin.requires.length > 0 && <p>Requires {plugin.requires.map(title).join(', ')}.</p>}
          {plugin.enabled && plugin.unloads.length > 0 && <p>Also disables {plugin.unloads.map(title).join(', ')}.</p>}
          {plugin.error && <p className="settings-error" role="alert">
            {plugin.status === 'degraded' ? 'Connection unavailable' : 'Could not start'}: {plugin.error}</p>}
          {plugin.status === 'blocked' && <p>Waiting for required plugins.</p>}
          {(plugin.status === 'failed' || plugin.status === 'blocked' || plugin.status === 'degraded') && <button type="button" className="ui-button"
            onClick={() => onChange(plugin.id, true)}>Retry {plugin.title}</button>}
        </div>
        <button type="button" className="ui-button ui-button--quiet plugin-toggle" role="switch" aria-label={plugin.title} aria-checked={plugin.enabled}
          onClick={() => onChange(plugin.id, !plugin.enabled)}>
          <span className="switch" aria-hidden="true"><i /></span>
        </button>
      </li>)}
    </ul>
  </>;
}
