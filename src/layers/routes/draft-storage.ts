import { isRecord } from '@zlayer/contracts';
import { routeTokensFromText, type RouteApproach, type RouteDraft, type RouteEntry, type RouteTerminal } from '@zlayer/domain';

/** Shared boundary for active drafts and saved routes. Legacy attachments acquire
 * explicit source/kind here; malformed attachments never discard their airport. */
export function parseRouteEntries(value: unknown): RouteDraft | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>(), entries: RouteEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
      typeof entry.text !== 'string' || routeTokensFromText(entry.text).length !== 1 ||
      routeTokensFromText(entry.text)[0] !== entry.text) return undefined;
    ids.add(entry.id);
    const approach = approachSelection(entry.approach);
    const departure = terminalSelection(entry.departure, 'departure'), arrival = terminalSelection(entry.arrival, 'arrival');
    entries.push({ id: entry.id, text: entry.text,
      ...(typeof entry.pinnedFeatureId === 'string' && entry.pinnedFeatureId ? { pinnedFeatureId: entry.pinnedFeatureId } : {}),
      ...(approach ? { approach } : {}), ...(departure?.kind === 'departure' ? { departure } : {}),
      ...(arrival?.kind === 'arrival' ? { arrival } : {}) });
  }
  return { entries };
}
const textFields = (value: Record<string, unknown>, fields: string[]) =>
  fields.every(field => typeof value[field] === 'string' && value[field].trim().length > 0);

function approachSelection(value: unknown): RouteApproach | undefined {
  if (!isRecord(value) || !textFields(value, ['airportId', 'procedureId', 'name', 'cycle']) ||
      value.kind !== undefined && value.kind !== 'approach' ||
      value.source !== undefined && value.source !== 'chart' && value.source !== 'cifp') return;
  const entry = isRecord(value.entry) && textFields(value.entry, ['routeId', 'transitionId', 'name', 'effectiveDate'])
    ? { routeId: value.entry.routeId as string, transitionId: value.entry.transitionId as string,
      name: value.entry.name as string, effectiveDate: value.entry.effectiveDate as string } : undefined;
  return { kind: 'approach', source: value.source === 'cifp' ? 'cifp' : 'chart',
    airportId: value.airportId as string, procedureId: value.procedureId as string,
    name: value.name as string, cycle: value.cycle as string, ...(entry ? { entry } : {}) };
}
function terminalSelection(value: unknown, kind: 'departure' | 'arrival'): RouteTerminal | undefined {
  if (!isRecord(value) || !textFields(value, ['airportId', 'procedureId', 'ident', 'name', 'effectiveDate']) ||
      typeof value.transition !== 'string' || value.kind !== undefined && value.kind !== kind) return;
  const source = value.source ?? (value.codedBranches === undefined ? 'nasr' : 'cifp');
  if (source !== 'nasr' && source !== 'cifp') return;
  const fields = { kind, airportId: value.airportId as string, procedureId: value.procedureId as string,
    ident: value.ident as string, name: value.name as string, effectiveDate: value.effectiveDate as string, transition: value.transition,
    ...(typeof value.branchName === 'string' && value.branchName ? { branchName: value.branchName } : {}) };
  if (source === 'nasr') {
    if (value.codedBranches !== undefined || value.codedRunway !== undefined || !value.transition.trim()) return;
    return { ...fields, source, ...(typeof value.branchId === 'string' && value.branchId ? { branchId: value.branchId } : {}) };
  }
  if (!textFields(value, ['branchId']) || !Array.isArray(value.codedBranches) || !value.codedBranches.length ||
      !value.codedBranches.every(id => typeof id === 'string' && id.length > 0) ||
      new Set(value.codedBranches).size !== value.codedBranches.length) return;
  return { ...fields, source, branchId: value.branchId as string, codedBranches: value.codedBranches as string[],
    ...(typeof value.codedRunway === 'string' && value.codedRunway ? { codedRunway: value.codedRunway } : {}) };
}
