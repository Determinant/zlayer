import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginStorage } from '../src/core/storage/plugin-storage';
import { pluginPreferences, booleanPreference } from '../src/core/storage/preferences';
import { layerPlugins } from '../src/core/layers/plugin';
import { isBoolean } from '../src/core/storage/ui-state';
import { routeDraftRecord } from '../src/layers/routes/persistent-draft';
import { changeRouteStash, readRouteStash, savedRoute, ROUTE_STASH_KEY } from '../src/layers/routes/stash';
import { routeDraftFromText } from '@zlayer/domain';

function setup(t: test.TestContext) {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  return { values, storage };
}

test('identical local names and document IDs stay isolated across plugin scopes and reloads', t => {
  const { values } = setup(t);
  const first = createPluginStorage('first'), second = createPluginStorage('second');
  const name = 'reader:https://example.test/a:b?document=one:scroll';
  first.ui(name, false, isBoolean).write(true);
  second.ui(name, true, isBoolean).write(false);
  assert.equal(createPluginStorage('first').ui(name, false, isBoolean).read(), true);
  assert.equal(createPluginStorage('second').ui(name, true, isBoolean).read(), false);
  assert.equal(values.size, 2);
  assert.equal(first.ui('missing', false, isBoolean).read(), false);
  assert.equal(values.size, 2, 'defaults do not create a record');
  for (const invalid of ['', 'first:other', 'first/other', '../second']) {
    assert.throws(() => createPluginStorage(invalid), /Invalid plugin storage identity/);
  }
  assert.throws(() => layerPlugins([{ definition: { id: 'second', title: 'Second' }, storage: first }]), /storage identity/);
  assert.throws(() => layerPlugins([first, first].map(storage => ({ definition: { id: 'first', title: 'First' }, storage }))), /Duplicate layer plugin/);
});

test('UI migration copies valid intent once; current invalid/newer records never resurrect legacy choices', t => {
  const { values } = setup(t);
  const scope = createPluginStorage('test', name => name === 'open' ? 'legacy-open' : undefined);
  const record = scope.ui('open', false, isBoolean);
  values.set('legacy-open', JSON.stringify({ version: 1, value: true }));
  assert.equal(record.read(), true);
  assert.equal(values.get(record.key), values.get('legacy-open'));
  record.write(false);
  assert.equal(record.read(), false);
  for (const raw of ['{broken', '{"version":99,"value":true}', '{"version":1,"value":"yes"}']) {
    values.set(record.key, raw);
    assert.equal(record.read(), false);
    assert.equal(values.get(record.key), raw);
  }
  values.delete(record.key);
  values.set('legacy-open', '{broken');
  assert.equal(record.read(), false);
  assert.equal(values.has(record.key), false);
});

test('new preference scopes do not adopt another plugin’s legacy fields without an explicit migration', t => {
  const { values } = setup(t);
  values.set('zlayers-map-preferences-v1', '{"version":2,"enabled":true}');
  const decode = (value: Record<string, unknown>) => ({ enabled: booleanPreference(value.enabled, false) });
  const original = createPluginStorage('original'), added = createPluginStorage('added');
  const oldPreferences = pluginPreferences(original, decode, 'zlayers-map-preferences-v1');
  const newPreferences = pluginPreferences(added, decode);
  assert.equal(oldPreferences.read().enabled, true);
  assert.equal(newPreferences.read().enabled, false);
  assert.throws(() => layerPlugins([{ definition: { id: 'added', title: 'Added' }, storage: added,
    preferences: oldPreferences }]), /Preferences must use the storage scope/);
});

test('denied storage and failed migration writes leave a usable session without erasing legacy data', t => {
  const { storage, values } = setup(t);
  const scope = createPluginStorage('test', () => 'legacy');
  values.set('legacy', '{"version":1,"value":true}');
  const record = scope.ui('open', false, isBoolean);
  storage.setItem = () => { throw new Error('quota'); };
  assert.equal(record.read(), true);
  assert.equal(values.size, 1);
  assert.doesNotThrow(() => record.write(false));
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
  assert.equal(record.read(), false);
  assert.doesNotThrow(() => record.write(true));
  assert.throws(() => scope.slot('stash').write('saved'), /denied/, 'explicit saves can report persistence failure');
});

test('legacy route migration commits generated IDs in the namespace and explicit clearing survives reload', t => {
  const { values } = setup(t);
  const legacy = JSON.stringify({ version: 1, input: 'KSFO KSJC', pinnedFeatureIds: { 0: 'airport:KSFO' } });
  values.set('zlayer-route-draft-v1', legacy);
  const restored = routeDraftRecord.read();
  assert.equal(restored.entries.length, 2);
  assert.equal(restored.entries[0]!.pinnedFeatureId, 'airport:KSFO');
  assert.deepEqual(routeDraftRecord.read(), restored);
  assert.equal(JSON.parse(values.get(routeDraftRecord.key)!).version, 2);
  assert.equal(values.get('zlayer-route-draft-v1'), legacy);
  routeDraftRecord.write({ entries: [] });
  assert.deepEqual(routeDraftRecord.read(), { entries: [] });
});

test('named saves read legacy data without writing outside the mutation lock; failed or corrupt saves remain intact', t => {
  const { storage, values } = setup(t);
  const route = savedRoute('Old route', routeDraftFromText('KSFO KSJC'));
  const legacy = JSON.stringify({ version: 1, routes: [route] });
  values.set('zlayer-route-stash-v1', legacy);
  assert.deepEqual(readRouteStash(storage), [route]);
  assert.equal(values.has(ROUTE_STASH_KEY), false);
  const fail = { ...storage, setItem() { throw new Error('quota'); } };
  assert.throws(() => changeRouteStash(() => [], fail), /Could not save/);
  assert.equal(values.get('zlayer-route-stash-v1'), legacy);
  changeRouteStash(() => [], storage);
  assert.deepEqual(readRouteStash(storage), []);
  values.set(ROUTE_STASH_KEY, '{broken');
  assert.throws(() => changeRouteStash(() => [], storage), /left untouched/);
  assert.equal(values.get(ROUTE_STASH_KEY), '{broken');
});
