import type { ProcedureResourceRecord, TerminalProceduresResource } from '@zlayer/contracts';
import { fetchTerminalProcedures } from './api';
import { fetchProcedureCatalog } from '../plates/api';
import { useRouteResource } from './use-resource';

/** All terminal pickers share retry and stale-result rules. Plate availability
 * remains independent of coded geometry availability. */
export function useProcedureResources(resource: ProcedureResourceRecord | undefined,
  terminal: TerminalProceduresResource | undefined, revision: string | undefined) {
  const key = JSON.stringify([revision, terminal]);
  const routes = useRouteResource(terminal && revision ? key : undefined,
    () => fetchTerminalProcedures(terminal!, revision!));
  const plates = useRouteResource(resource ? JSON.stringify(resource) : undefined,
    () => fetchProcedureCatalog(resource!));
  return { key, routes, plates };
}
