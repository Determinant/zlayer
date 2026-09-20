import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';

const records = new Map<string, unknown>();
const held = new Set<string>();
const state = { beforeWrite: async (_key: string, _value: unknown) => {}, failRead: false };
Object.assign(globalThis, { activeRecordTest: { records, state } });
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/storage/database')) return {
    url: 'data:text/javascript,' + encodeURIComponent(`
      const { records, state } = globalThis.activeRecordTest;
      export const readOfflineRecord = async key => records.get(key);
      export const writeOfflineRecord = async (key, value) => {
        await state.beforeWrite(key, value);
        if (value === undefined) records.delete(key); else records.set(key, value);
      };
      export const offlineRecordKeys = async prefix => {
        if (state.failRead) throw new Error('Storage unavailable');
        return [...records.keys()].filter(key => key.startsWith(prefix));
      };
    `), shortCircuit: true,
  };
  return next(specifier, context);
} });
const { retainActiveFiles, pruneInactiveRecords } = await import('../src/offline/active-catalogs');
loader.deregister();

function setup(t: test.TestContext) {
  records.clear(); held.clear(); state.failRead = false;
  state.beforeWrite = async () => {};
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const locks = {
    async request(name: string, options: LockOptions | ((lock: object) => unknown), callback?: (lock: object | null) => unknown) {
      // Web Locks grant callbacks asynchronously, including immediately available locks.
      await Promise.resolve();
      const work = typeof options === 'function' ? options : callback!;
      if (held.has(name)) {
        assert.equal(typeof options === 'object' && options.ifAvailable, true);
        return callback!(null);
      }
      held.add(name);
      try { return await work({ name }); } finally { held.delete(name); }
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  t.after(async () => {
    await pruneInactiveRecords();
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
}

test('abandoned metadata is reclaimed while live owners and saved records are preserved', async t => {
  setup(t);
  for (const key of ['active-catalog:closed', 'active-files:closed', 'active-catalog:live', 'active-files:live',
    'catalog:saved', 'bundle-snapshot:saved', 'region:saved']) records.set(key, key);
  held.add('active-catalog:live'); held.add('active-files:live');
  await pruneInactiveRecords();
  assert.deepEqual([...records.keys()], ['active-catalog:live', 'active-files:live', 'catalog:saved', 'bundle-snapshot:saved', 'region:saved']);
  held.clear();
  await pruneInactiveRecords();
  assert.deepEqual([...records.keys()], ['catalog:saved', 'bundle-snapshot:saved', 'region:saved']);
});

test('retention holds ownership through delayed publication and deletion', async t => {
  setup(t);
  let publish!: () => void, remove!: () => void;
  const publishing = new Promise<void>(resolve => { publish = resolve; });
  const removing = new Promise<void>(resolve => { remove = resolve; });
  state.beforeWrite = async (key, value) => {
    assert.ok(held.has(key), 'the record is locked before writing and until deletion commits');
    await (value === undefined ? removing : publishing);
  };
  const release = retainActiveFiles(['https://charts.test/open.pdf']);
  await tick();
  const key = [...held].find(key => key.startsWith('active-files:'))!;
  assert.ok(key);
  assert.equal(records.has(key), false);
  await pruneInactiveRecords();
  publish(); await tick();
  await pruneInactiveRecords();
  assert.deepEqual(records.get(key), ['https://charts.test/open.pdf']);
  release(); await tick();
  assert.ok(held.has(key));
  await pruneInactiveRecords();
  assert.ok(records.has(key), 'cleanup cannot race an owner still releasing its record');
  remove(); await tick();
  assert.equal(records.has(key), false);
  assert.equal(held.has(key), false);
});

test('immediate unmount leaves no record and failed cleanup can be retried', async t => {
  setup(t);
  let writes = 0;
  state.beforeWrite = async () => { writes++; };
  retainActiveFiles(['https://charts.test/never-opened.pdf'])();
  await tick();
  assert.equal(writes, 0);
  assert.equal(held.size, 0);
  records.set('active-files:closed', ['https://charts.test/closed.pdf']);
  state.failRead = true;
  await assert.rejects(pruneInactiveRecords(), /Storage unavailable/);
  assert.ok(records.has('active-files:closed'));
  state.failRead = false;
  await pruneInactiveRecords();
  assert.equal(records.size, 0);
});
