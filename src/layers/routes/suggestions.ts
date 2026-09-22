import type { AirwayDataResponse, NavigationData, PreferredRoutesData, TerminalProceduresData } from '@zlayer/contracts';
import { routeDraftText, preferredRouteAirports, preferredRoutesForAirports,
  type RouteAirportPair, type RouteHistoryResults, type RoutePlan } from '@zlayer/domain';
import { routeResolver } from './resolver';
import { preferredRouteDraft, type RouteDraft } from './draft';
import { createFiledRouteDraft } from './history/draft';
import { routeConditions } from './conditions';
import type { RoutePreview } from './map-preview';
import type { SavedRoute } from './stash';

export type SuggestionCategory = 'frequency' | 'preferred' | 'tec' | 'stash';
export type RouteSuggestion = {
  id: string; route: string; detail: string;
  conditions: [string, string][]; draft: RouteDraft | undefined;
};

export function createRecommendationModel(
  history: RouteHistoryResults | undefined, preferred: PreferredRoutesData | undefined,
  pair: RouteAirportPair, navigation: NavigationData, airways?: AirwayDataResponse,
  terminal?: TerminalProceduresData, stash: readonly SavedRoute[] = [],
) {
  const filedDraft = createFiledRouteDraft(pair, navigation);
  const published = preferredRoutesForAirports(preferred?.routes ?? [], pair);
  const groups: Record<SuggestionCategory, RouteSuggestion[]> = { frequency: [], preferred: [], tec: [], stash: [] };
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
  for (const saved of stash) {
    const { draft } = saved;
    if (draft.entries.length < 2) continue;
    const first = draft.entries[0]!, last = draft.entries.at(-1)!;
    const endpoints = preferredRouteAirports([first.text, last.text], navigation.airports?.features ?? [], {
      ...(first.pinnedFeatureId ? { 0: first.pinnedFeatureId } : {}),
      ...(last.pinnedFeatureId ? { 1: last.pinnedFeatureId } : {}),
    });
    if (!endpoints || !sameAirport(endpoints.origin, pair.origin) || !sameAirport(endpoints.destination, pair.destination)) continue;
    groups.stash.push({ id: `stash:${saved.id}`, route: routeDraftText(draft), detail: saved.name || 'Saved route',
      conditions: [], draft });
  }
  const suggestions = [...groups.frequency, ...groups.preferred, ...groups.tec, ...groups.stash];
  const resolve = routeResolver(navigation, airways, terminal, preferred);
  const plans = new Map<string, RoutePlan>();
  const planFor = (suggestion: RouteSuggestion): RoutePlan | undefined => {
    if (!suggestion.draft) return undefined;
    if (!plans.has(suggestion.id)) plans.set(suggestion.id, resolve(suggestion.draft));
    return plans.get(suggestion.id);
  };
  const preview = (selectedId?: string): RoutePreview => {
    const routes: RoutePreview['routes'] = [];
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

function sameAirport(left: RouteAirportPair['origin'], right: RouteAirportPair['origin']): boolean {
  return left === right || !!left.id && left.id === right.id;
}

/** Equal paths share one map overlay, even when listed in more than one section. */
export function recommendationGeometryKey(plan: RoutePlan | undefined): string | undefined {
  if (!plan?.legs.length) return undefined;
  return JSON.stringify([
    plan.legs.map(leg => leg.geometry ?? [leg.from.feature.geometry.coordinates, leg.to.feature.geometry.coordinates]),
    (plan.planningConnections ?? []).map(({ from, to, start }) =>
      [start ?? from.feature.geometry.coordinates, to.feature.geometry.coordinates]),
    plan.approachExtensions ?? [],
    (plan.approachDepictions ?? []).map(({ kind, phase, coordinates }) => [kind, phase, coordinates]),
  ]);
}
