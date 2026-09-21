import { useEffect, useState } from 'react';
import type { ProcedureResourceRecord, TerminalProceduresResource } from '@zlayer/contracts';
import { fetchTerminalProcedures } from './api';
import { fetchProcedureCatalog } from '../plates/api';

function useResource<T>(key: string, attempt: number, load: (() => Promise<T>) | undefined) {
  const [loaded, setLoaded] = useState<{ key: string; data?: T; error?: boolean }>();
  useEffect(() => {
    if (!load) return;
    let active = true;
    setLoaded({ key });
    void load().then(data => { if (active) setLoaded({ key, data }); },
      () => { if (active) setLoaded({ key, error: true }); });
    return () => { active = false; };
    // The serialized resource and edition completely identify the request.
  }, [key, attempt]);
  return loaded?.key === key ? loaded : undefined;
}

/** All terminal pickers share retry and stale-result rules. Plate availability
 * remains independent of coded geometry availability. */
export function useProcedureResources(resource: ProcedureResourceRecord | undefined,
  terminal: TerminalProceduresResource | undefined, revision: string | undefined) {
  const [attempt, retry] = useState(0);
  const key = JSON.stringify([revision, terminal]);
  const routes = useResource(key, attempt, terminal && revision ? () => fetchTerminalProcedures(terminal, revision) : undefined);
  const plates = useResource(JSON.stringify(resource), attempt, resource ? () => fetchProcedureCatalog(resource) : undefined);
  return { key, routes, plates, retry };
}
