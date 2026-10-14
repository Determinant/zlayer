import { useEffect, useMemo } from 'react';
import type { CatalogResponse, NavigationData } from '@zlayer/contracts';
import { attachRouteDepartures, captureRadialPositions, featureIdentifiers, isVorReference, parseRadialDefinition, type RouteDraft, type RoutePlan } from '@zlayer/domain';
import { useReferenceBearing } from './use-reference-bearing';
import { useRouteReferences, type RouteLoadStatus } from './use-references';
import { routeResolver } from './resolver';

export type { RouteLoadStatus } from './use-references';

export function useRoutePlan(
  catalog: CatalogResponse | undefined,
  draft: RouteDraft,
  onNormalize?: (edit: (current: RouteDraft) => RouteDraft) => void,
): { plan: RoutePlan; data: NavigationData; status: RouteLoadStatus } {
  const active = draft.entries.length > 0;
  const { resolver, data, terminal, status, pending } = useRouteResolver(catalog, active, draft);
  const resolved = useMemo(() => resolver(draft), [draft, resolver]);
  // Incremental resolution is provisional: later products can reveal an
  // ambiguous reference. Do not persist inferred positions or procedures yet.
  const normalized = useMemo(() => pending ? draft
    : captureRadialPositions(attachRouteDepartures(draft, resolved, terminal), resolved), [draft, resolved, terminal, pending]);
  useEffect(() => { if (normalized !== draft) onNormalize?.(current => current === draft ? normalized : current); }, [draft, normalized, onNormalize]);
  const plan = useMemo(() => normalized === draft ? resolved : resolver(normalized), [draft, normalized, resolved, resolver]);
  return { plan, data, status };
}

/** One resource subscription and shared national index for an active view. */
export function useRouteResolver(catalog: CatalogResponse | undefined, active: boolean, draft?: RouteDraft) {
  const { data, airways, terminal, preferred, status, pending } = useRouteReferences(catalog, active);
  const vorIdentifiers = useMemo(() => new Set(data.navaids?.features.filter(isVorReference).flatMap(featureIdentifiers)), [data.navaids]);
  const needsMagnetic = useMemo(() => draft?.entries.some(entry => {
    const definition = parseRadialDefinition(entry.text);
    if (!definition || definition.bearing === 'true' || definition.bearing === 'radial') return false;
    if (definition.bearing === 'magnetic' || entry.radialPosition?.reference.bearing === 'magnetic') return true;
    return Object.keys(data).length > 0 && !vorIdentifiers.has(definition.station);
  }) ?? false, [draft, data, vorIdentifiers]);
  const magnetic = useReferenceBearing(catalog?.revision, active && needsMagnetic);
  // GPS coordinates resolve independently of navigation-resource availability.
  const resolver = useMemo(() => routeResolver(data, airways, terminal, preferred, magnetic), [data, airways, terminal, preferred, magnetic]);
  return { resolver, data, terminal, status, pending };
}
