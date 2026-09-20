import { useEffect, useMemo, useState } from 'react';
import type { CatalogResponse, GeoPointFeature } from '@zlayer/contracts';
import { nearbyVorStations } from '@zlayer/domain';
import { useOnline } from '../../core/use-online';
import { useInventoryVersion } from '../../offline/use-inventory-version';
import { fetchNavigation, navigationRequestKey } from './api';
import { fillMissingNavaidAlignment } from './identification-data';

/** Read the selected feature's edition, independent of route and map visibility. */
export function useNavaidIdentification(point: GeoPointFeature | undefined, catalog: CatalogResponse | undefined) {
  const online = useOnline();
  const inventoryVersion = useInventoryVersion();
  const layer = point ? catalog?.navigation.find(layer => layer.id === 'navaids') : undefined;
  const key = layer && catalog ? navigationRequestKey(layer, catalog.revision, []) : undefined;
  const [loaded, setLoaded] = useState<{
    key: string; status: 'loading' | 'ready' | 'error'; features?: GeoPointFeature[];
  }>();
  useEffect(() => {
    if (!key || !layer || !catalog) return;
    const controller = new AbortController();
    setLoaded({ key, status: 'loading' });
    void fetchNavigation(layer, catalog.revision, []).then(async collection => {
      if (controller.signal.aborted) return;
      setLoaded({ key, status: 'ready', features: collection.features });
      const features = await fillMissingNavaidAlignment(collection.features, catalog.revision, controller.signal);
      if (!controller.signal.aborted) setLoaded({ key, status: 'ready', features });
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded({ key, status: 'error' });
    });
    return () => { controller.abort(); };
  }, [key, layer, catalog, online, inventoryVersion]);
  const features = key && loaded?.key === key ? loaded.features : undefined;
  const stations = useMemo(() => point && features ? nearbyVorStations(point.geometry.coordinates, features) : undefined,
    [point, features]);
  return { stations, loading: Boolean(key && (loaded?.key !== key || loaded.status === 'loading')) };
}
