import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceCache } from '../src/core/data/resource-cache';

test('immutable resources coalesce pending loads, evict cold successes and retry failures or partial values', async () => {
  const cache = new ResourceCache<number>(2);
  let calls = 0;
  let finish!: (value: number) => void;
  const pending = cache.get('pending', () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(cache.get('pending', async () => 99), pending);
  await cache.get('a', async () => ++calls);
  await cache.get('b', async () => ++calls);
  await cache.get('c', async () => ++calls);
  assert.equal(cache.get('pending', async () => 99), pending, 'capacity never duplicates in-flight work');
  finish(10);
  assert.equal(await pending, 10);
  assert.equal(await cache.get('c', async () => 99), 4);
  assert.equal(await cache.get('a', async () => 20), 20, 'cold successes are released');
  await assert.rejects(cache.get('fail', async () => { throw new Error('retry'); }), /retry/);
  assert.equal(await cache.get('fail', async () => 30), 30);
  await cache.get('partial', async () => 0, value => value > 0);
  assert.equal(await cache.get('partial', async () => 40), 40);
});

test('retention failures reject the shared request and leave the resource retryable', async () => {
  const cache = new ResourceCache<number>();
  const failed = cache.get('resource', async () => 1, () => { throw new Error('Invalid result'); });
  assert.equal(cache.get('resource', async () => 99), failed);
  await assert.rejects(failed, /Invalid result/);
  assert.equal(await cache.get('resource', async () => 2), 2);
  assert.equal(await cache.get('resource', async () => 99), 2);
});
