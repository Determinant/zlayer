import { useState } from 'react';
import { TabList, tabPanelProps } from '../core/ui/tabs';
import { formatDate } from '../core/format/time';
import { usePersistentState } from '../core/ui/use-persistent-state';
import { isBoolean } from '../core/storage/ui-state';
import type { ChartCatalog } from '../workspace/catalog/catalog';
import type { CycleSelection } from '../workspace/catalog/cycles';
import { ErrorBoundary } from '../core/layers/error-boundary';
import { AboutLauncher } from './about';
import { SettingsDialog } from './settings-dialog';
import Settings from './settings';
import { ResetSettings } from './reset-settings';
import { PwaUpdateSettings } from './pwa-update';
import { PluginSettings } from './plugin-settings';
import type { PluginControl } from '../core/layers/use-plugins';

const SETTINGS_TABS = [{ value: 'general', label: 'General' }, { value: 'plugins', label: 'Plugins' }] as const;

export function SettingsLauncher({ catalog, cycles, selection, onCycleChange, cycleNotice, plugins, onPluginChange, pluginError }: {
  catalog: ChartCatalog;
  cycles: string[];
  selection: CycleSelection;
  onCycleChange: (selection: CycleSelection) => void;
  cycleNotice?: string | undefined;
  plugins: readonly PluginControl[];
  onPluginChange(id: string, loaded: boolean): void;
  pluginError?: string | undefined;
}) {
  const [visible, setVisible] = usePersistentState('settings-open', false, isBoolean);
  const [opened, setOpened] = useState(visible);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = usePersistentState<'general' | 'plugins'>('settings-tab', 'general',
    (value): value is 'general' | 'plugins' => value === 'general' || value === 'plugins');
  const retry = () => setAttempt(value => value + 1);
  return <>
    <button type="button" className="ui-button ui-button--icon settings-button" aria-label="Settings and offline downloads"
      title="Settings and offline downloads" onClick={() => { retry(); setOpened(true); setVisible(true); }}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
        strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M10.19 5.24 10.26 2.15 13.74 2.15 13.81 5.24 15.5 5.94 17.74 3.81 20.19 6.26
          18.06 8.5 18.76 10.19 21.85 10.26 21.85 13.74 18.76 13.81 18.06 15.5 20.19 17.74
          17.74 20.19 15.5 18.06 13.81 18.76 13.74 21.85 10.26 21.85 10.19 18.76 8.5 18.06
          6.26 20.19 3.81 17.74 5.94 15.5 5.24 13.81 2.15 13.74 2.15 10.26 5.24 10.19
          5.94 8.5 3.81 6.26 6.26 3.81 8.5 5.94Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
    {opened && <SettingsDialog open={visible} onClose={() => setVisible(false)}>
      <TabList id="settings" label="Settings sections" tabs={SETTINGS_TABS} value={tab} onChange={setTab} className="settings-tabs" />
      <div className="settings-body panel-scroll" {...tabPanelProps('settings', 'general', tab)}>
        <section aria-labelledby="general-settings-title">
          <div className="settings-section-heading">
            <h3 id="general-settings-title">General</h3>
            <AboutLauncher />
          </div>
          <label className="settings-cycle">FAA data cycle
            <select className="ui-input" aria-describedby="cycle-description" value={selection}
              onChange={event => onCycleChange(event.target.value)}>
              <option value="latest">Default · Latest</option>
              {cycles.map(revision => <option key={revision} value={revision}>FAA {formatDate(revision)}</option>)}
            </select>
          </label>
          <p id="cycle-description">Browsing FAA {formatDate(catalog.revision)}. Default follows the latest available cycle.
            {' '}This applies to browsing and new downloads. Saved regions keep their downloaded editions.</p>
          {cycleNotice && <p className="settings-cycle-notice" role="status">{cycleNotice}</p>}
        </section>
        <PwaUpdateSettings />
        <ErrorBoundary resetKey={attempt} fallback={error => <div>
          <p className="settings-error" role="alert">Settings unavailable: {error.message}</p>
          <button className="ui-button" type="button" onClick={retry}>Retry settings</button>
        </div>}>
          <Settings catalog={catalog} open={visible && tab === 'general'} />
        </ErrorBoundary>
        {visible && tab === 'general' && <ResetSettings />}
      </div>
      <div className="settings-body panel-scroll" {...tabPanelProps('settings', 'plugins', tab)}>
        <PluginSettings plugins={plugins} onChange={onPluginChange} error={pluginError} />
      </div>
    </SettingsDialog>}
  </>;
}
