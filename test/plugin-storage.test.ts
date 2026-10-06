import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred } from './helpers/deferred';
import { createPluginStorage } from '../src/core/storage/plugin-storage';
import { pluginPreferences, booleanPreference } from '../src/core/storage/preferences';
import { layerPlugins } from '../src/core/layers/plugin';
import { isBoolean } from '../src/core/storage/ui-state';
import { routeDraftRecord } from '../src/layers/routes/draft-storage';
import { changeRouteStash, readRouteStash, savedRoute, ROUTE_STASH_KEY } from '../src/layers/routes/stash';
import { routeDraftFromText } from '@zlayer/domain';

function setup(t: test.TestContext) {
  const values = new Map<string, string>();
  const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); }, getItem: (key: string) => values.get(key) ?? null,
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

test('optional record limits bound UTF-16 storage and skip oversized restores before decoding', t => {
  const { values } = setup(t);
  const scope = createPluginStorage('bounded', undefined, { maxRecordBytes: 8 });
  scope.slot('raw').write('four');
  assert.throws(() => scope.slot('raw').write('large'), /storage limit/);
  assert.equal(scope.slot('raw').read(), 'four');
  values.set(scope.slot('raw').key, 'too large');
  assert.equal(scope.slot('raw').read(), null);
  const record = scope.record('record', { version: 1, fallback: 'fallback',
    decode: () => assert.fail('oversized record must not be decoded'), encode: (value: string) => value });
  values.set(record.key, '"too large"');
  assert.equal(record.read(), 'fallback');
  assert.doesNotThrow(() => record.write('larger'));
  assert.equal(values.get(record.key), '"too large"');
  assert.throws(() => createPluginStorage('bounded', undefined, { maxRecordBytes: 0 }), /record limit/);
});

test('record writes preserve readable data when the serialized replacement fails its decoder', t => {
  const { values } = setup(t);
  const scope = createPluginStorage('test');
  const record = () => scope.record<number[]>('numbers', { version: 1, fallback: [],
    decode: value => Array.isArray(value) && value.length <= 2 && value.every(v => typeof v === 'number') ? value : undefined,
    encode: value => value });
  record().write([1, 2]);
  const saved = values.get(record().key);
  for (const invalid of [[1, 2, 3], [NaN], [Infinity]]) {
    assert.doesNotThrow(() => record().write(invalid));
    assert.equal(values.get(record().key), saved);
    assert.deepEqual(record().read(), [1, 2], 'validate the JSON representation, including non-finite numbers becoming null');
  }
  record().write([]);
  assert.deepEqual(record().read(), [], 'valid empty replacements still persist');
});

test('decoder exceptions do not commit records or evict existing view state', t => {
  const { values } = setup(t);
  const scope = createPluginStorage('test', undefined, { uiRetention: [{ prefix: 'view:', limit: 1 }] });
  scope.ui('view:retained', false, isBoolean).write(true);
  const saved = [...values];
  const rejected = scope.record('view:new', { version: 1, fallback: false,
    decode: () => { throw new Error('Invalid data'); }, encode: (value: boolean) => value });
  assert.doesNotThrow(() => rejected.write(true));
  assert.deepEqual([...values], saved);
  assert.equal(rejected.read(), false);
});

test('coordinated records merge independent writers and reject invalid updates without replacing saved values', async t => {
  setup(t);
  const record = () => createPluginStorage('test').record<number[]>('shared', { version: 1, fallback: [],
    decode: value => Array.isArray(value) && value.length <= 2 && value.every(v => typeof v === 'number') ? value : undefined,
    encode: value => value });
  const a = record(), b = record();
  assert.deepEqual(await Promise.all([a.update(saved => [...saved, 1]), b.update(saved => [...saved, 2])]), [true, true]);
  assert.deepEqual(record().read(), [1, 2]);
  assert.equal(await a.update(saved => [...saved, 3]), false);
  assert.deepEqual(record().read(), [1, 2]);
});

for (const failure of ['abort', 'timeout'] as const) test(`a queued record update cannot write after ${failure}`, async t => {
  setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const record = createPluginStorage('test').record('shared', { version: 1, fallback: 0,
    decode: value => typeof value === 'number' ? value : undefined, encode: (value: number) => value });
  record.write(1);
  const entered = deferred(), release = deferred();
  const holding = navigator.locks.request(record.key, async () => { entered.resolve(); await release.promise; });
  t.after(async () => { release.resolve(); await holding; });
  await entered.promise;
  let changes = 0; const abort = new AbortController();
  const pending = record.update(saved => { changes++; return saved + 1; }, abort.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  if (failure === 'abort') abort.abort(); else t.mock.timers.tick(10_000);
  assert.equal(await pending, false);
  release.resolve(); await holding;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(changes, 0); assert.equal(record.read(), 1);
  assert.equal(await record.update(saved => saved + 1), true, 'a later update can recover');
  assert.equal(record.read(), 2);
});

test('coordinated records skip writes if locks or the storage read are unavailable', async t => {
  const { storage, values } = setup(t);
  const record = createPluginStorage('test').record('shared', { version: 1, fallback: 0,
    decode: value => typeof value === 'number' ? value : undefined, encode: (value: number) => value });
  record.write(1);
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const restoreLocks = () => descriptor ? Object.defineProperty(navigator, 'locks', descriptor) : Reflect.deleteProperty(navigator, 'locks');
  t.after(restoreLocks);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  assert.equal(await record.update(() => 2), false);
  Object.defineProperty(navigator, 'locks', { configurable: true, get() { throw new Error('Locks denied'); } });
  assert.equal(await record.update(() => 2), false);
  restoreLocks();
  const read = storage.getItem;
  storage.getItem = () => { throw new Error('Storage denied'); };
  assert.equal(await record.update(() => 2), false, 'an unreadable record cannot be treated as missing');
  assert.equal(values.get(record.key), '1');
  storage.getItem = read;
  assert.equal(await record.update(saved => saved + 1), true);
  assert.equal(record.read(), 2);
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


test('view retention bounds identities, preserves other records and cannot resurrect evicted legacy state', t => {
  const { values } = setup(t);
  const scope = createPluginStorage('bounded', name => `zlayer-ui:${name}`,
    { uiRetention: [{ prefix: 'view:', limit: 2 }] });
  values.set('zlayer-ui:view:old', '{"version":1,"value":true}');
  values.set('zlayer-plugin:other:view:old', '{"version":1,"value":true}');
  scope.ui('selection', false, isBoolean).write(true);
  scope.ui('view:a', false, isBoolean).write(true);
  scope.ui('view:b', false, isBoolean).write(true);
  assert.equal(values.has('zlayer-ui:view:old'), false);
  assert.equal(scope.ui('view:old', false, isBoolean).read(), false);
  assert.equal(scope.ui('selection', false, isBoolean).read(), true);
  assert.equal(values.has('zlayer-plugin:other:view:old'), true);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1000 });
  scope.ui('view:a', false, isBoolean).write(false);
  scope.ui('view:c', false, isBoolean).write(true);
  assert.equal(values.has('zlayer-plugin:bounded:view:b'), false, 'least recently written identity is removed');
  assert.equal(scope.ui('view:a', true, isBoolean).read(), false);
  assert.equal(scope.ui('view:c', false, isBoolean).read(), true);
  assert.equal([...values.keys()].filter(key => key.startsWith('zlayer-plugin:bounded:view:')).length, 2);
});
