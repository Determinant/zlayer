import type { AirwayDataResponse, CatalogResponse, NavigationData, NavigationLayerId, PreferredRoutesData, TerminalProceduresData } from '@zlayer/contracts';
import { fetchAirways, fetchNavigationResult, navigationRequestKey } from '../navigation/api';
import { fetchPreferredRoutes, fetchTerminalProcedures } from './api';
import { navigationSourceKey } from '../../workspace/read-context';

type Scope = 'plan' | 'recommendations';
export type RouteReferenceData = {
  data: NavigationData;
  airways?: AirwayDataResponse | undefined;
  terminal?: TerminalProceduresData | undefined;
  preferred?: PreferredRoutesData | undefined;
};

export function routeResourceKey(catalog: CatalogResponse, scope: Scope): string {
  return JSON.stringify([navigationSourceKey(catalog),
    catalog.navigation.map(layer => navigationRequestKey(layer, catalog.revision, [])),
    catalog.airways, catalog.terminalProcedures, scope === 'plan' ? catalog.preferredRoutes : undefined]);
}

/** Merge only within one complete source identity. Preserve catalog order and
 * healthy references across retries without rebuilding unchanged indexes. */
export function mergeRouteReferences(catalog: CatalogResponse, current: RouteReferenceData | undefined,
  update: Partial<RouteReferenceData>): RouteReferenceData {
  const collections = catalog.navigation.flatMap(layer => {
    const collection = update.data?.[layer.id] ?? current?.data[layer.id];
    return collection ? [collection] : [];
  });
  const data = current && Object.keys(current.data).length === collections.length &&
    collections.every(collection => current.data[collection.meta.layer] === collection)
    ? current.data : Object.fromEntries(collections.map(collection => [collection.meta.layer, collection]));
  const airways = update.airways ?? current?.airways;
  const terminal = update.terminal ?? current?.terminal;
  const preferred = update.preferred ?? current?.preferred;
  if (current?.data === data && current.airways === airways && current.terminal === terminal && current.preferred === preferred) return current;
  return { data, ...(airways ? { airways } : {}), ...(terminal ? { terminal } : {}), ...(preferred ? { preferred } : {}) };
}

/** One national edition supplies each route operation. Publish validated products
 * as they arrive so slow or failed exports cannot hold up healthy navigation. */
export async function loadRouteResources(catalog: CatalogResponse, scope: Scope,
  onReady?: (resources: Partial<RouteReferenceData>) => void) {
  // Saved-route recommendations can include VFR waypoints, just like the active plan.
  const layers = catalog.navigation;
  const [navigation, airway, procedures, preferredRoutes] = await Promise.allSettled([
    Promise.all(layers.map(async layer => {
      const result = await fetchNavigationResult(layer, catalog.revision, [], catalog);
      if (result.collection) onReady?.({ data: { [layer.id]: result.collection } });
      return result;
    })),
    catalog.airways ? fetchAirways(catalog.airways, catalog.revision)
      .then(airways => { onReady?.({ airways }); return airways; }) : Promise.resolve(undefined),
    catalog.terminalProcedures ? fetchTerminalProcedures(catalog.terminalProcedures, catalog.revision)
      .then(terminal => { onReady?.({ terminal }); return terminal; }) : Promise.resolve(undefined),
    scope === 'plan' && catalog.preferredRoutes ? fetchPreferredRoutes(catalog.preferredRoutes, catalog.revision)
      .then(preferred => { onReady?.({ preferred }); return preferred; }) : Promise.resolve(undefined),
  ]);
  const collections = navigation.status === 'fulfilled' ? navigation.value.flatMap(result => result.collection ?? []) : [];
  const unavailable: NavigationLayerId[] = navigation.status === 'fulfilled'
    ? layers.filter((_, index) => !navigation.value[index]!.collection).map(layer => layer.id) : layers.map(layer => layer.id);
  const failed = navigation.status === 'rejected' || unavailable.length > 0 || airway.status === 'rejected' ||
    procedures.status === 'rejected' || preferredRoutes.status === 'rejected';
  const data: NavigationData = Object.fromEntries(collections.map(collection => [collection.meta.layer, collection]));
  return { data, unavailable, failed,
    airways: airway.status === 'fulfilled' ? airway.value : undefined,
    terminal: procedures.status === 'fulfilled' ? procedures.value : undefined,
    preferred: preferredRoutes.status === 'fulfilled' ? preferredRoutes.value : undefined,
  };
}
