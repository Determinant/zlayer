import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainVectorCache, type TerrainVectors } from '../src/layers/terrain/vector-cache';

const vectors = (): TerrainVectors => ({ labels: [], lines: [] });

test('visible terrain survives cache pressure and revisits promote it without changing draw order', () => {
  const cache = new TerrainVectorCache(3), first = vectors(), second = vectors();
  cache.setVisible(['first', 'second']);
  cache.put('first', first); cache.put('second', second);
  for (let i = 0; i < 200; i++) cache.put(`other:${i}`, vectors());
  assert.equal(cache.size, 3);
  assert.deepEqual(cache.visible(), [first, second]);
  cache.setVisible(['second', 'first']);
  assert.deepEqual(cache.visible(), [first, second], 'coverage ordering must not reshuffle labels');
  cache.setVisible([]);
  cache.put('new', vectors());
  assert.ok(cache.has('first') && cache.has('second'), 'recently viewed tiles outlive cold entries');
  assert.ok(!cache.has('other:199'));
});

test('large visible coverage may exceed the cache budget but shrinks immediately when it leaves view', () => {
  const cache = new TerrainVectorCache(3), keys = ['a', 'b', 'c', 'd', 'e'];
  cache.setVisible(keys);
  keys.forEach(key => cache.put(key, vectors()));
  assert.equal(cache.size, 5);
  cache.put('offscreen', vectors());
  assert.equal(cache.size, 5); assert.equal(cache.has('offscreen'), false);
  cache.setVisible(['e']);
  assert.equal(cache.size, 3); assert.ok(cache.has('e'));
  cache.clear();
  assert.equal(cache.size, 0); assert.deepEqual(cache.visible(), []);
});
