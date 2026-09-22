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
        <div><h4>{plugin.title}</h4><span className="plugin-status">{plugin.loaded ? 'Enabled' : 'Disabled'}</span>
          {plugin.requires.length > 0 && <p>Requires {plugin.requires.map(title).join(', ')}.</p>}
          {plugin.loaded && plugin.unloads.length > 0 && <p>Also disables {plugin.unloads.map(title).join(', ')}.</p>}
        </div>
        <button type="button" aria-label={`${plugin.loaded ? 'Disable' : 'Enable'} ${plugin.title}`}
          onClick={() => onChange(plugin.id, !plugin.loaded)}>{plugin.loaded ? 'Disable' : 'Enable'}</button>
      </li>)}
    </ul>
  </>;
}
