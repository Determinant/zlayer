// Included only by the test server. Exercises the actual Canvas clipping path.
import type { CatalogResponse } from '@zlayer/contracts';
import { createWorkspaceReadContext } from '../../src/workspace/read-context';
import { OFFLINE_REGIONS } from '../../src/offline/regions';
import { worldPoint } from '../../src/offline/region-coverage';
import { regionalTileParts, renderRegionalTile } from '../../src/layers/charts/regional-tiles';

export async function regionalPixels(missingNevada: boolean) {
  const make = (revision: string): CatalogResponse => ({ schemaVersion: 1, revision,
    generatedAt: `${revision}T00:00:00Z`, charts: [], navigation: [], weather: [] });
  const browsing = make('2026-10-01'), ca = make('2026-09-03'), nv = make('2026-08-06');
  const bundles = [ca, nv].map((catalog, index) => {
    const region = OFFLINE_REGIONS.find(region => region.code === (index ? 'NV' : 'CA'))!;
    return { catalog, bounds: region.bounds, key: region.id,
      plan: { id: region.id, regionId: region.id, title: region.title, revision: catalog.revision, files: [], references: [] } };
  });
  const catalog = createWorkspaceReadContext(browsing, bundles);
  const tile = { z: 7, x: 21, y: 48 };
  const bitmap = await renderRegionalTile(regionalTileParts(catalog, tile), async source => {
    if (source === nv && missingNevada) throw new Error('Nevada archive unavailable');
    const canvas = new OffscreenCanvas(256, 256), context = canvas.getContext('2d')!;
    context.fillStyle = source === ca ? '#0000ff' : source === nv ? '#00ff00' : '#ff0000';
    context.fillRect(0, 0, 256, 256);
    return canvas.transferToImageBitmap();
  }, new AbortController().signal) as ImageBitmap;
  const canvas = new OffscreenCanvas(256, 256), context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0); bitmap.close();
  const at = (point: [number, number]) => {
    const [x, y] = worldPoint(point);
    return [...context.getImageData(Math.floor((x * 128 - tile.x) * 256), Math.floor((y * 128 - tile.y) * 256), 1, 1).data];
  };
  return { truckee: at([-120.15, 39.33]), reno: at([-119.7681, 39.4991]) };
}

// Vite app entries do not preserve unused exports; expose this test-only entry.
(globalThis as unknown as { regionalTestPixels: typeof regionalPixels }).regionalTestPixels = regionalPixels;
