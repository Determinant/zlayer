import { useEffect, useState } from 'react';
import { clearSessionData, purgeLocalData, RESET_KEY, resetPending } from '../core/storage/reset';

export function ResetScreen({ requested }: { requested: boolean }) {
  const [message, setMessage] = useState('Preparing reset…');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!requested) return;
    let disposed = false;
    const finish = () => { if (!disposed) { setDone(true); setError(undefined); } };
    const changed = (event: StorageEvent) => {
      if (event.key === RESET_KEY && event.newValue === null) finish();
    };
    window.addEventListener('storage', changed);
    setError(undefined);
    void (async () => {
      clearSessionData();
      if (resetPending()) await purgeLocalData(value => { if (!disposed) setMessage(value); });
      finish();
    })().catch(error => { if (!disposed) setError(error instanceof Error ? error.message : 'Reset failed. Retry.'); });
    return () => { disposed = true; window.removeEventListener('storage', changed); };
  }, [attempt, requested]);
  return <main className="reset-screen"><section className="reset-card" aria-labelledby="reset-title">
    <img src="/icon.svg" alt="" width="44" height="44" />
    <h1 id="reset-title">{!requested ? 'No reset requested' : done ? 'Local data cleared' : 'Reset ZLayer'}</h1>
    {!requested ? <><p>No data has been deleted. Start a reset from Settings → General → Advanced.</p><a className="ui-button ui-button--primary" href="/">Open ZLayer</a></> : done ? <>
      <p>Your saved downloads and workspace data have been removed.</p>
      <p>Connect to the internet to reopen ZLayer, then download any regions you need offline.</p>
      <a className="ui-button ui-button--primary" href="/">Open ZLayer</a>
    </> : <>
      <p role="status">{message}</p>
      {error && <><p role="alert">{error}</p>
        <button className="ui-button ui-button--primary" type="button" onClick={() => setAttempt(value => value + 1)}>Retry reset</button></>}
    </>}
  </section></main>;
}
