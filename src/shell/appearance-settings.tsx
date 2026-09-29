import { useSyncExternalStore } from 'react';
import { getTheme, setTheme, subscribeTheme } from '../core/theme/preference';

export function AppearanceSettings() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'dark');
  return <fieldset className="settings-appearance" aria-describedby="appearance-description">
    <legend>Appearance</legend>
    <div className="appearance-options">
      {(['light', 'dark'] as const).map(value => <label key={value}>
        <input type="radio" name="appearance" value={value} checked={theme === value}
          onChange={() => setTheme(value)} />
        <span>{value === 'light' ? 'Light' : 'Dark'}</span>
      </label>)}
    </div>
    <p id="appearance-description">Choose the appearance of menus and controls.</p>
  </fieldset>;
}
