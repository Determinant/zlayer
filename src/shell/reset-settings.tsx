import { useState } from 'react';
import { beginReset } from '../core/storage/reset';

export function ResetSettings() {
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string>();
  return <details className="reset-settings" onToggle={event => {
    if (!event.currentTarget.open) { setConfirmation(''); setError(undefined); }
  }}>
    <summary>Advanced</summary>
    <h3>Delete all local data</h3>
    <p>This permanently removes all saved regions, charts, plates, reference and weather data,
      AHRS recordings, your route, map view, preferences, and the offline app cache from this browser.
      All open ZLayer windows will stop. You will need a connection to use ZLayer again.</p>
    <p>Your home-screen icon and browser permissions are managed by your browser.</p>
    <label>Type DELETE to confirm
      <input className="ui-input" value={confirmation} onChange={event => setConfirmation(event.target.value)}
        autoComplete="off" spellCheck={false} autoCapitalize="characters" aria-describedby="reset-warning" />
    </label>
    <p id="reset-warning">This cannot be undone.</p>
    <button type="button" className="ui-button ui-button--danger" disabled={confirmation !== 'DELETE'} onClick={() => {
      try { beginReset(); }
      catch (error) { setError(error instanceof Error ? error.message : 'Could not start the reset. Retry.'); }
    }}>Delete all local data</button>
    {error && <p className="settings-error" role="alert">{error}</p>}
  </details>;
}
