import assert from 'node:assert/strict';
import test from 'node:test';
import type { TerrainSource } from '@zlayer/contracts';
import { terrainSourceKey, packagesForTerrainTile } from '../src/layers/terrain/sources';

const base = 'https://terrain.test/app/';
const source: TerrainSource = { schemaVersion: 1, encoding: 'float32-feet-gzip', minZoom: 1, maxZoom: 13,
  generatedAt: '2026-09-03T00:00:00Z', root: '../terrain', shards: [320, 384].map(x => ({
    zoom: 13, x, y: 320, file: `${'a'.repeat(64)}.terrain`, sha256: 'a'.repeat(64), byteLength: 100,
  })) };
const key = (sources: TerrainSource[]) => terrainSourceKey(sources, base);
const tile = { z: 13, x: 320, y: 320 };

test('terrain identity ignores metadata, shard ordering, equivalent roots and fully shadowed sources', () => {
  const equivalent = { ...structuredClone(source), generatedAt: '2026-09-20T00:00:00Z',
    root: 'https://terrain.test/terrain/', shards: [...source.shards].reverse() };
  assert.equal(key([equivalent]), key([source]));
  const shadowed = { ...source, root: '/unused' };
  assert.equal(key([source, shadowed]), key([source]));
  assert.equal(key([{ ...source, shards: [] }]), key([]));
  assert.deepEqual(packagesForTerrainTile([source, shadowed], tile, base), packagesForTerrainTile([source], tile, base));
});

test('terrain identity follows source precedence, coverage, content and byte identity', () => {
  const other = { ...source, root: '/other' };
  assert.notEqual(key([source, other]), key([other, source]));
  assert.equal(packagesForTerrainTile([other, source], tile, base)[0]!.root, 'https://terrain.test/other');
  assert.notEqual(key([source]), key([{ ...source, shards: source.shards.slice(1) }]));
  for (const fields of [{ byteLength: 101 }, { sha256: 'b'.repeat(64), file: `${'b'.repeat(64)}.terrain` },
    { zoom: 12 }, { x: 448 }, { y: 384 }]) {
    assert.notEqual(key([source]), key([{ ...source, shards: [{ ...source.shards[0]!, ...fields }, source.shards[1]!] }]));
  }
});

test('splitting or reordering disjoint sources of one format keeps the same terrain identity', () => {
  const first = { ...source, shards: source.shards.slice(0, 1) };
  const second = { ...source, shards: source.shards.slice(1) };
  assert.equal(key([first, second]), key([source]));
  assert.equal(key([second, first]), key([source]));
});
