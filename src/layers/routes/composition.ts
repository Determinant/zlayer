import type { RoutePlan } from '@zlayer/domain';

export type RouteComposition = {
  tec: RoutePlan['tecRoutes'][number]['route'] | undefined;
  airways: RoutePlan['airways'];
  procedures: Array<RoutePlan['procedures'][number] & (
    { source: 'nasr' } | { source: 'cifp'; branch: string; path: NonNullable<RoutePlan['terminalPaths']>[number] }
  )>;
  issues: RoutePlan['issues'];
};

/** Select an occurrence, including expansions nested inside its TEC definition. */
export function routeEntryComposition(plan: RoutePlan, entryId: string): RouteComposition | undefined {
  const tokenIndex = plan.entries.findIndex(entry => entry.id === entryId);
  if (tokenIndex < 0) return undefined;
  const tec = plan.tecRoutes.find(route => route.tokenIndex === tokenIndex)?.route;
  const airways = plan.airways.filter(route => route.tokenIndex === tokenIndex);
  const procedures: RouteComposition['procedures'] = plan.procedures.filter(route => route.tokenIndex === tokenIndex).map(route => {
    const path = plan.terminalPaths?.find(path => path.kind === route.kind && path.owner.source.entryId === entryId && path.owner.ident === route.ident);
    return path ? { ...route, source: 'cifp', branch: plan.entries[tokenIndex]![route.kind]?.branchName ?? '', path }
      : { ...route, source: 'nasr' };
  });
  const issues = plan.issues.filter(issue => issue.tokenIndex === tokenIndex);
  if (!tec && !airways.length && !procedures.length &&
      !issues.some(issue => /^(tec|airway|procedure)-/.test(issue.code))) return undefined;
  return { tec, airways, procedures, issues };
}
