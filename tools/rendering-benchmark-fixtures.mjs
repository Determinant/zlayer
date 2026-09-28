import { createHash } from 'node:crypto';
import { encode } from 'fast-png';
import initSqlJs from 'sql.js';

// Deterministic linework/noise, not a surrogate for the size of real FAA imagery.
// Unlike the ordinary one-world-tile fixture, this exercises package churn.
export async function renderingBenchmarkFixtures(files) {
  const SQL = await initSqlJs(), bounds = [-122, 38, -118, 41];
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const coordinate = (lon, lat, z) => [Math.floor((lon + 180) / 360 * 2 ** z),
    Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z)];
  const latitude = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;
  const manifestHashes = [];
  let totalBytes = 0, totalTiles = 0, totalPackages = 0;
  for (const [edition, revision] of ['2026-08-06', '2026-09-03'].entries()) {
    const images = Array.from({ length: 4 }, (_, variant) => {
      const data = new Uint8Array(256 * 256 * 4);
      let seed = 12345 + variant;
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const offset = (y * 256 + x) * 4;
        const line = x % 32 < 2 || y % 32 < 2 || (x + y + variant * 8) % 61 < 2;
        const shade = line ? 40 : 180 + (seed >>> 28);
        data.set(edition ? [shade, shade, Math.min(255, shade + 45), 255]
          : [Math.min(255, shade + 45), shade, shade, 255], offset);
      }
      return encode({ width: 256, height: 256, data, channels: 4, depth: 8 });
    });
    const archives = [];
    for (let z = 6; z <= 10; z++) {
      const [west, north] = coordinate(bounds[0], bounds[3], z), [east, south] = coordinate(bounds[2], bounds[1], z);
      for (let rootY = Math.floor(north / 4); rootY <= Math.floor(south / 4); rootY++) {
        for (let rootX = Math.floor(west / 4); rootX <= Math.floor(east / 4); rootX++) {
          const db = new SQL.Database();
          db.run('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)');
          let mask = 0n;
          try {
            for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
              const x = rootX * 4 + dx, y = rootY * 4 + dy;
              if (x < west || x > east || y < north || y > south) continue;
              mask |= 1n << BigInt(dy * 4 + dx); totalTiles++;
              db.run('INSERT INTO tiles VALUES (?, ?, ?, ?)', [z, x, 2 ** z - y - 1, images[(x + y) % 4]]);
            }
            const body = Buffer.from(db.export()), digest = sha(body);
            const id = `vfr-sectional-z${z}-r${z - 2}-${rootX}-${rootY}`, file = `${id}-${digest}.mbtiles`;
            files.set(`/chart-data/${revision}/mbtiles/${file}`, { body, type: 'application/octet-stream' });
            totalBytes += body.length; totalPackages++;
            archives.push({ id, kind: 'vfr-sectional', zoom: z, root: { z: z - 2, x: rootX, y: rootY },
              file, byteLength: body.length, sha256: digest, tileMask: mask.toString(16),
              bounds: [rootX * 4 / 2 ** z * 360 - 180, latitude((rootY + 1) * 4, z),
                (rootX + 1) * 4 / 2 ** z * 360 - 180, latitude(rootY * 4, z)] });
          } finally { db.close(); }
        }
      }
    }
    const path = `/chart-data/${revision}/mbtiles/manifest.json`;
    const manifest = JSON.parse(files.get(path).body);
    manifest.charts[0] = { ...manifest.charts[0], bounds, minZoom: 6, maxZoom: 10 };
    manifest.archives = archives;
    manifest.regions = [{ id: 'benchmark', title: 'Rendering benchmark', bounds: [bounds], archiveIds: archives.map(a => a.id) }];
    const body = Buffer.from(JSON.stringify(manifest));
    files.set(path, { body, type: 'application/json' }); manifestHashes.push(sha(body));
  }
  return { version: 1, bounds, minZoom: 6, maxZoom: 10, totalTiles, totalPackages, totalBytes, manifestHashes };
}
