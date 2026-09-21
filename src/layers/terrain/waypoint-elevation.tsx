import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoPointFeature } from '@zlayer/contracts';
import { restoreRouteCoordinate } from '@zlayer/domain';
import type { CatalogReadSource } from '../../workspace/read-context';
import { WorkerClient } from '../../core/data/worker-client';
import { observeOfflineInventory } from '../../offline/inventory-events';
import { DEFAULT_ELEVATION_URL } from './elevation';
import { terrainPointLocation } from './point-elevation';
import { packagesForTerrainTile, terrainSources, terrainSourceKey } from './sources';
import type { TerrainWorker } from './types';

type ElevationState = { key: string; height: number | null };

export function WaypointElevation({ feature, catalog, active }: {
  feature: GeoPointFeature; catalog?: CatalogReadSource | undefined; active: boolean;
}) {
  const [longitude, latitude] = restoreRouteCoordinate(feature).geometry.coordinates;
  const base = globalThis.location?.href ?? 'http://localhost/';
  const sources = useMemo(() => terrainSources(catalog), [catalog]);
  const sourceKey = useMemo(() => terrainSourceKey(sources, base), [sources, base]);
  const [revision, refresh] = useState(0);
  const key = JSON.stringify([longitude, latitude, sourceKey, revision]);
  const [result, setResult] = useState<ElevationState>();
  const completed = useRef<ElevationState>(undefined);
  const latestSources = useRef(sources);
  latestSources.current = sources;
  useEffect(() => {
    const retry = () => refresh(value => value + 1);
    const stop = observeOfflineInventory(retry);
    window.addEventListener('online', retry);
    return () => { stop(); window.removeEventListener('online', retry); };
  }, []);
  useEffect(() => {
    if (!active || completed.current?.key === key) return;
    let client: WorkerClient<TerrainWorker> | undefined;
    let canceled = false;
    const finish = (height: number | null) => {
      if (canceled) return;
      completed.current = { key, height };
      setResult(completed.current);
    };
    void (async () => {
      try {
        const location = terrainPointLocation([longitude, latitude]);
        if (!location) { finish(null); return; }
        client = new WorkerClient<TerrainWorker>(new Worker(new URL('./terrain.worker.ts', import.meta.url),
          { type: 'module' }), 'Terrain elevation unavailable');
        const request = { id: 0, ...location,
          tileUrl: import.meta.env?.VITE_ZLAYERS_TERRAIN_TILE_URL?.trim() || DEFAULT_ELEVATION_URL,
          packages: packagesForTerrainTile(latestSources.current, location.tile, base) };
        finish(await client.call(remote => remote.sample(request)));
      } catch { finish(null); }
      finally { client?.dispose(); }
    })();
    return () => { canceled = true; client?.dispose(); };
  }, [key, longitude, latitude, base, active]);
  const current = result?.key === key ? result : undefined;
  const rounded = current?.height == null ? undefined : Math.round(current.height / 10) * 10;
  return <span aria-live="polite">
    {rounded !== undefined ? `≈ ${(rounded || 0).toLocaleString('en-US')} ft MSL` : current ? 'Unavailable' : 'Loading…'}
    {current?.height === null && <> <button className="feature-fact-retry" type="button" onClick={() => refresh(value => value + 1)}
      aria-label="Retry terrain elevation">Retry</button></>}
  </span>;
}
