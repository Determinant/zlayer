import type { CatalogResponse, NavigationData, NavigationLayerId } from '@zlayer/contracts';
import { fetchAirways, fetchNavigationCollections, navigationRequestKey } from '../navigation/api';
import { fetchPreferredRoutes, fetchTerminalProcedures } from './api';
import { navigationSourceKey } from '../../workspace/read-context';

type Scope = 'plan' | 'recommendations';

export function routeResourceKey(catalog: CatalogResponse, scope: Scope): string {
  return JSON.stringify([navigationSourceKey(catalog),
    catalog.navigation.map(layer => navigationRequestKey(layer, catalog.revision, [])),
    catalog.airways, catalog.terminalProcedures, scope === 'plan' ? catalog.preferredRoutes : undefined]);
}

/** One national edition supplies each route operation. Products settle separately
 * so a failed optional export never discards healthy navigation. */
export async function loadRouteResources(catalog: CatalogResponse, scope: Scope) {
  // Saved-route recommendations can include VFR waypoints, just like the active plan.
  const layers = catalog.navigation;
  const [navigation, airway, procedures, preferredRoutes] = await Promise.allSettled([
    fetchNavigationCollections(layers, catalog.revision, [], catalog),
    catalog.airways ? fetchAirways(catalog.airways, catalog.revision) : Promise.resolve(undefined),
    catalog.terminalProcedures ? fetchTerminalProcedures(catalog.terminalProcedures, catalog.revision) : Promise.resolve(undefined),
    scope === 'plan' && catalog.preferredRoutes ? fetchPreferredRoutes(catalog.preferredRoutes, catalog.revision) : Promise.resolve(undefined),
  ]);
  const collections = navigation.status === 'fulfilled' ? navigation.value.collections : [];
  const unavailable: NavigationLayerId[] = navigation.status === 'fulfilled' ? navigation.value.unavailable : layers.map(layer => layer.id);
  const failed = navigation.status === 'rejected' || unavailable.length > 0 || airway.status === 'rejected' ||
    procedures.status === 'rejected' || preferredRoutes.status === 'rejected';
  const data: NavigationData = Object.fromEntries(collections.map(collection => [collection.meta.layer, collection]));
  return { data, unavailable, failed,
    airways: airway.status === 'fulfilled' ? airway.value : undefined,
    terminal: procedures.status === 'fulfilled' ? procedures.value : undefined,
    preferred: preferredRoutes.status === 'fulfilled' ? preferredRoutes.value : undefined,
  };
}
