import { fetchJson } from '../../src/core/data/fetch-json';
import { isTerrainManifest } from '@zlayer/contracts';
import { createBrowserDownloads } from '../../src/offline/browser-downloads';
import type { DownloadPlan } from '../../src/offline/downloads';
import { terrainArchiveUrl } from '@zlayer/contracts';

type Fixture = boolean | 'fine';
const fixtureName = (geographic: Fixture) => geographic === 'fine' ? 'terrain-geographic-fine'
  : geographic ? 'terrain-geographic' : 'terrain-fixture';
const source = async (geographic: Fixture = false) => {
  const root = new URL(`/chart-data/${fixtureName(geographic)}`, location.href).href;
  return { ...await fetchJson(`${root}/manifest.json`, isTerrainManifest, 'Test terrain'), root };
};
const id = (geographic: Fixture) => `${fixtureName(geographic)}-selection`;
const downloads = createBrowserDownloads(async () => { throw new Error('Unexpected PDF'); });

export async function save(geographic: Fixture = false) {
  const terrain = await source(geographic), root = terrain.root, shard = terrain.shards[0]!;
  const plan: DownloadPlan = { id: id(geographic), regionId: id(geographic), title: 'Terrain fixture',
    revision: '2026-09-03', terrain: true, bounds: [[-122.01, 37.01, -122.009, 37.011]],
    references: [], files: [{ kind: 'terrain', url: terrainArchiveUrl(root, shard), byteLength: shard.byteLength, sha256: shard.sha256 }],
    catalog: { schemaVersion: 1, generatedAt: '2026-09-03T00:00:00Z', revision: '2026-09-03',
      charts: [], navigation: [], weather: [], terrain } };
  await downloads.start(plan);
  return downloads.snapshot().find(job => job.id === id(geographic));
}

export async function check(geographic: Fixture = false) {
  await downloads.restore();
  return downloads.snapshot().find(job => job.id === id(geographic));
}

export async function probe(zoom: number, geographic: Fixture = false): Promise<number[]> {
  const terrain = await source(geographic), root = terrain.root;
  const worker = new Worker(new URL('./terrain-storage.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.values);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage(geographic ? { geographicSource: terrain, displayZoom: zoom }
        : { root, shard: terrain.shards.find(shard => shard.zoom === zoom) });
    });
  } finally { worker.terminate(); }
}
