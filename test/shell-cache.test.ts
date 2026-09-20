import assert from 'node:assert/strict';
import test from 'node:test';
import { pruneShellCaches } from '../src/core/storage/shell-cache';

test('shell cleanup retains the running and installed editions and never removes data caches', async t => {
  const names = new Map([
    ['zlayers-shell-old', '<script src="/assets/app-old.js"></script>'],
    ['zlayers-shell-current', '<script src="/assets/app-current.js"></script>'],
    ['zlayers-shell-unused', '<script src="/assets/app-unused.js"></script>'],
    ['zlayers-chart-archives-v3', 'chart data'], ['zlayers-data-v6', 'reference data'],
  ]);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: {
    keys: async () => [...names.keys()], delete: async (name: string) => names.delete(name),
    open: async (name: string) => ({ match: async () => new Response(names.get(name)) }),
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'caches', original) : Reflect.deleteProperty(globalThis, 'caches'));
  await pruneShellCaches('zlayers-shell-current', 'https://app.test/assets/unknown.js', 'https://app.test');
  assert.equal(names.size, 5, 'an unrecognized page must retain its possible lazy chunks');
  await pruneShellCaches('zlayers-shell-current', 'https://app.test/assets/app-old.js', 'https://app.test');
  assert.ok(names.has('zlayers-shell-old'));
  assert.ok(names.has('zlayers-shell-current'));
  assert.equal(names.has('zlayers-shell-unused'), false);
  await pruneShellCaches('zlayers-shell-current', 'https://app.test/assets/app-current.js', 'https://app.test');
  assert.deepEqual([...names.keys()], ['zlayers-shell-current', 'zlayers-chart-archives-v3', 'zlayers-data-v6']);
});

test('shell cleanup stops if an update begins while the cache inventory is being read', async t => {
  const names = new Set(['zlayers-shell-current', 'zlayers-shell-installing']);
  let safe = true;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: {
    keys: async () => [...names], delete: async (name: string) => names.delete(name),
    open: async (name: string) => ({ match: async () => {
      if (name === 'zlayers-shell-installing') { safe = false; return undefined; }
      return new Response('<script src="/assets/current.js"></script>');
    } }),
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'caches', original) : Reflect.deleteProperty(globalThis, 'caches'));
  await pruneShellCaches('zlayers-shell-current', 'https://app.test/assets/current.js', 'https://app.test', () => safe);
  assert.equal(names.has('zlayers-shell-installing'), true, 'the incomplete shell belongs to the installing update');
});
