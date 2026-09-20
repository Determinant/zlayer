import type { AirwayDataResponse, NavigationData, PreferredRoutesData, TerminalProceduresData } from '@zlayer/contracts';
import { routeDraftText, preferredRoutesForAirports, type RouteAirportPair, type RouteHistoryResults, type RoutePlan } from '@zlayer/domain';
import { routeResolver } from './resolver';
import { preferredRouteDraft, type RouteDraft } from './draft';
import { createFiledRouteDraft } from './history/draft';
import { routeConditions } from './conditions';

export type SuggestionCategory = 'frequency' | 'preferred' | 'tec';
export type RouteSuggestion = {
  id: string; route: string; detail: string;
  conditions: [string, string][]; draft: RouteDraft | undefined;
};
export type RecommendationPreview = {
  routes: { key: string; plan: RoutePlan }[];
  selectedKey: string;
};
export type RecommendationInset = { right: number; bottom: number };
export type RouteRecommendationsMap = RecommendationPreview & { inset: RecommendationInset; preserveView?: boolean };

export function createRecommendationModel(
  history: RouteHistoryResults | undefined, preferred: PreferredRoutesData | undefined,
  pair: RouteAirportPair, navigation: NavigationData, airways?: AirwayDataResponse,
  terminal?: TerminalProceduresData,
) {
  const filedDraft = createFiledRouteDraft(pair, navigation);
  const published = preferredRoutesForAirports(preferred?.routes ?? [], pair);
  const groups: Record<SuggestionCategory, RouteSuggestion[]> = { frequency: [], preferred: [], tec: [] };
  for (const entry of history?.routes ?? []) {
    const share = entry.count / history!.totalCount * 100;
    const percent = share < 0.1 ? '<0.1' : share.toLocaleString(undefined, { maximumFractionDigits: 1 });
    groups.frequency.push({ id: `frequency:${entry.route}`, route: entry.route,
      detail: `${entry.count.toLocaleString()} ${entry.count === 1 ? 'use' : 'uses'} · ${percent}%`,
      conditions: [], draft: filedDraft(entry.route) });
  }
  for (const entry of published) {
    const category = entry.routeType === 'TEC' ? 'tec' : 'preferred';
    const draft = preferredRouteDraft(entry, pair, navigation);
    const type = ({ L: 'Low', H: 'High', NAR: 'North American' } as Record<string, string>)[entry.routeType];
    groups[category].push({ id: entry.id, route: draft ? routeDraftText(draft) : entry.route ?? 'No published route', draft,
      detail: [entry.designator || `Route ${entry.routeNumber}`, type].filter(Boolean).join(' · '),
      conditions: routeConditions(entry) });
  }
  const suggestions = [...groups.frequency, ...groups.preferred, ...groups.tec];
  const resolve = routeResolver(navigation, airways, terminal, preferred);
  const plans = new Map<string, RoutePlan>();
  const planFor = (suggestion: RouteSuggestion): RoutePlan | undefined => {
    if (!suggestion.draft) return undefined;
    if (!plans.has(suggestion.id)) plans.set(suggestion.id, resolve(suggestion.draft));
    return plans.get(suggestion.id);
  };
  const preview = (selectedId?: string): RecommendationPreview => {
    const routes: RecommendationPreview['routes'] = [];
    const append = (suggestion: RouteSuggestion) => {
      const plan = planFor(suggestion);
      const key = recommendationGeometryKey(plan);
      if (plan && key && !routes.some(route => route.key === key)) routes.push({ key, plan });
    };
    for (const suggestion of suggestions) {
      append(suggestion);
      if (routes.length === 5) break;
    }
    const selected = suggestions.find(suggestion => suggestion.id === selectedId);
    const selectedPlan = selected && planFor(selected);
    const selectedKey = recommendationGeometryKey(selectedPlan);
    if (selectedPlan && selectedKey) {
      const index = routes.findIndex(route => route.key === selectedKey);
      const route = { key: selectedKey, plan: selectedPlan };
      // Shared geometry still needs the selected route's labels and procedure styling.
      if (index >= 0) routes[index] = route;
      else {
        if (routes.length === 5) routes.pop();
        routes.push(route);
      }
    }
    return { routes, selectedKey: selectedKey ?? routes[0]?.key ?? '' };
  };
  return { groups, planFor, preview };
}

/** Equal paths share one map overlay, even when listed in more than one section. */
export function recommendationGeometryKey(plan: RoutePlan | undefined): string | undefined {
  return plan?.legs.length ? JSON.stringify(plan.legs.map(leg =>
    [leg.from.feature.geometry.coordinates, leg.to.feature.geometry.coordinates])) : undefined;
}
