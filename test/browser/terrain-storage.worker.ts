import type { TerrainSource } from '@zlayer/contracts';
import { packagesForTerrainTile } from '../../src/layers/terrain/sources';
import { packagesForElevationTile } from '../../src/layers/terrain/geographic';
import { ElevationTiles } from '../../src/layers/terrain/elevation';
import { readTerrainIndex, type TerrainPackage } from '../../src/layers/terrain/packages';

self.onmessage = async ({ data }: MessageEvent<TerrainPackage | { geographicSource: TerrainSource; displayZoom: number }>) => {
  try {
    const signal = new AbortController().signal;
    if ('geographicSource' in data) {
      const z = data.displayZoom, n = 2 ** z;
      const px = (-122.01 + 180) / 360 * n, py = (1 - Math.asinh(Math.tan(37.01 * Math.PI / 180)) / Math.PI) / 2 * n;
      const tile = { z, x: Math.floor(px), y: Math.floor(py) };
      const parent = { z: z - 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) };
      const packages = packagesForElevationTile(packagesForTerrainTile([data.geographicSource], parent, location.href), tile);
      const values = await new ElevationTiles().read(tile, 'https://invalid.test/no-png', signal, packages);
      const sample = Math.floor((py - tile.y) * 256) * 256 + Math.floor((px - tile.x) * 256);
      self.postMessage({ values: [values[sample]], finite: values.filter(Number.isFinite).length });
      return;
    }
    const index = await readTerrainIndex(data, signal), a = index.archives[0]!;
    const values = await new ElevationTiles().read({ z: a.zoom, x: a.x, y: a.y }, 'https://invalid.test/no-png', signal, data);
    self.postMessage({ values: Array.from(values.slice(0, 4)) });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
