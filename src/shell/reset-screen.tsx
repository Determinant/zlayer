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
  return <main className="reset-screen">
    <h1>{!requested ? 'No reset requested' : done ? 'Local data cleared' : 'Reset ZLayer'}</h1>
    {!requested ? <><p>No data has been deleted. Start a reset from Settings → Advanced.</p><a href="/">Open ZLayer</a></> : done ? <>
      <p>Saved downloads and workspace data have been removed. Reconnect before opening ZLayer.</p>
      <a href="/">Open ZLayer</a>
    </> : <>
      <p role="status">{message}</p>
      {error && <><p role="alert">{error}</p>
        <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry reset</button></>}
    </>}
  </main>;
}
