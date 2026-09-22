import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';
import type { LayerPlugin } from '../src/core/layers/plugin';
import { chartPreferences } from '../src/layers/charts/preferences';
import { navigationPreferences } from '../src/layers/navigation/preferences';
import { terrainPreferences } from '../src/layers/terrain/preferences';
import { ownshipPreferences } from '../src/layers/ownship/preferences';
import { obstructionPreferences } from '../src/layers/obstructions/preferences';
import { metarPreferences } from '../src/layers/metar-taf/preferences';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { useMapPreferences } = await import('../src/workspace/use-map-preferences');
loader.deregister();
const globals = globalThis as unknown as { testHooks: Hooks; window: unknown };
const key = 'zlayers-map-preferences-v1';
const terrainKey = 'zlayer-plugin:terrain:preferences';
// Supply descriptors without loading the plugins' UI and map runtimes.
const plugins = [chartPreferences, navigationPreferences, terrainPreferences, ownshipPreferences, obstructionPreferences, metarPreferences]
  .map(preferences => ({ definition: { id: preferences.key, title: preferences.key }, preferences }));
type PreferenceTestPlugin = typeof plugins[number] | Pick<LayerPlugin, 'definition'>;

function setup(t: test.TestContext, initial?: string, owners: readonly PreferenceTestPlugin[] = plugins) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>(initial === undefined ? [] : [[key, initial]]);
  const storage = { getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  let hooks = new Hooks();
  const render = () => { globals.testHooks = hooks; return hooks.render(() => useMapPreferences(owners)); };
  t.after(() => {
    hooks.unmount();
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { storage, render, restart: () => { hooks.unmount(); hooks = new Hooks(); return render(); } };
}

test('map preferences use the supplied owner records and skip plugins without preferences', t => {
  const saved: object[] = [];
  const owners = plugins.map(plugin => plugin.preferences === terrainPreferences ? {
    ...plugin,
    preferences: { ...terrainPreferences, read: () => ({ ...terrainPreferences.read(), terrainAltitude: 8500 }),
      write: (value: object) => { saved.push(value); } },
  } : plugin);
  const { render } = setup(t, undefined, [{ definition: { id: 'plain', title: 'Plain' } }, ...owners]);
  assert.equal(render()[0].terrainAltitude, 8500, 'the registered record supplies the initial value');
  render()[1](current => ({ ...current, terrainAltitude: 9000 }));
  assert.deepEqual(saved, [{ terrainEnabled: true, terrainCoverage: 'route', terrainAltitude: 9000 }],
    'the same owner receives only its changed fields');
});

test('overlapping preference fields fail visibly instead of overwriting another owner', t => {
  const duplicate = { ...plugins[0]!, definition: { id: 'duplicate-charts', title: 'Duplicate charts' } };
  const { render } = setup(t, undefined, [...plugins, duplicate]);
  assert.throws(render, /Duplicate map preference chartBase: .* and duplicate-charts/);
});

test('a smaller registration exposes only its own preference fields', t => {
  const { storage } = setup(t);
  const hooks = new Hooks(); globals.testHooks = hooks;
  t.after(() => hooks.unmount());
  const [preferences, update] = hooks.render(() => useMapPreferences([
    { definition: { id: 'charts', title: 'Charts' }, preferences: chartPreferences },
  ]));
  assert.equal(preferences.chartBase, undefined);
  // @ts-expect-error Missing owners cannot promise terrain fields to the caller.
  assert.equal(preferences.terrainEnabled, undefined);
  update(current => ({ ...current, chartBase: 'ifr-low' }));
  assert.equal(JSON.parse(storage.getItem('zlayer-plugin:charts:preferences')!).chartBase, 'ifr-low');
  assert.equal(storage.getItem(terrainKey), null, 'only the supplied owner writes a record');
});

test('map choices survive a fresh app mount, including false switches and base-map-only', t => {
  const { render, restart } = setup(t);
  const [defaults, setPreferences] = render();
  assert.equal(defaults.chartBase, undefined, 'first launch leaves automatic base selection intact');
  assert.equal(defaults.visibility.fixes, true, 'IFR fixes are enabled by default');
  assert.equal(defaults.terrainEnabled, true, 'terrain starts enabled without a saved preference');
  assert.equal(defaults.terrainCoverage, 'route', 'existing route coverage remains the default');
  assert.equal(defaults.obstructionsEnabled, true);
  assert.equal(defaults.ownshipEnabled, true, 'GPS starts enabled without a saved preference');
  setPreferences(current => ({ ...current, chartBase: 'ifr-low', chartOverlay: 'vfr-terminal', metarEnabled: false, terrainEnabled: false, obstructionsEnabled: false,
    visibility: { airports: false, navaids: false, 'vfr-waypoints': false, fixes: true },
    fixDisplay: { detail: 'all', airspace: 'high' }, ownshipEnabled: false,
  }));
  const chosen = render()[0];
  assert.deepEqual(restart()[0], chosen);
  restart()[1](current => ({ ...current, chartBase: '', fixDisplay: { ...current.fixDisplay, detail: 'terminal' } }));
  const baseOnly = render()[0];
  assert.equal(baseOnly.chartBase, '');
  assert.equal(baseOnly.chartOverlay, 'vfr-terminal', 'inactive overlay choice is remembered');
  assert.deepEqual(restart()[0], baseOnly);
  assert.equal(baseOnly.fixDisplay.airspace, 'high', 'All temporarily shows both bands without erasing the saved band');
});

test('invalid fields fall back independently without discarding valid choices', t => {
  const { render } = setup(t, JSON.stringify({ chartOverlay: 'made-up', metarEnabled: false, terrainEnabled: 'false',
    visibility: { airports: false, fixes: 'false', unknown: true },
    fixDisplay: { detail: 'terminal', airspace: 'wrong' },
  }));
  assert.deepEqual(render()[0], { chartBase: undefined, chartOverlay: '', metarEnabled: false, terrainEnabled: true, terrainCoverage: 'route', obstructionsEnabled: true, terrainAltitude: null, ownshipEnabled: true,
    visibility: { airports: false, navaids: true, 'vfr-waypoints': true, fixes: true },
    fixDisplay: { detail: 'terminal', airspace: 'low' },
  });
});

test('corrupt JSON and unavailable storage do not break startup or session changes', t => {
  const { render, restart, storage } = setup(t, '{broken');
  const defaults = render()[0];
  assert.deepEqual(restart()[0], defaults, 'persisting defaults must not turn automatic selection into base-map-only');
  for (const value of ['null', '42', '[]']) {
    storage.setItem(key, value);
    assert.deepEqual(restart()[0], defaults);
  }
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied'); } });
  const [restored, update] = restart();
  assert.deepEqual(restored, defaults);
  update(current => ({ ...current, chartOverlay: '', metarEnabled: false }));
  assert.equal(render()[0].metarEnabled, false);
});

for (const [old, base, overlay] of [
  ['vfr-sectional', 'vfr-sectional', ''], ['ifr-low', 'ifr-low', ''],
  ['vfr-terminal', 'vfr-sectional', 'vfr-terminal'], ['vfr-flyway', 'vfr-sectional', 'vfr-flyway'],
  ['', '', ''],
]) {
  test(`migrates legacy chart choice ${old || 'base-map-only'} to a base/overlay stack`, t => {
    const { render, restart } = setup(t, JSON.stringify({ chartOverlay: old, metarEnabled: false }));
    const preferences = render()[0];
    assert.equal(preferences.chartBase, base);
    assert.equal(preferences.chartOverlay, overlay);
    assert.equal(preferences.metarEnabled, false);
    assert.equal(preferences.terrainEnabled, true, 'older preferences without terrain settings enable terrain');
    assert.deepEqual(restart()[0], preferences);
  });
}

test('quota errors preserve settings in memory', t => {
  const { render, storage } = setup(t);
  const [initial, update] = render();
  assert.equal(initial.visibility.fixes, true);
  const write = t.mock.method(storage, 'setItem', () => { throw new Error('Quota exceeded'); });
  update(current => ({ ...current, visibility: { ...current.visibility, fixes: false } }));
  assert.equal(render()[0].visibility.fixes, false);
  assert.equal(write.mock.calls.length, 1, 'the changed preference survives a failed write');
});

test('selected terrain altitude persists, including zero, and invalid stored altitudes use elevation mode', t => {
  const { render, restart, storage } = setup(t);
  assert.equal(render()[0].terrainAltitude, null);
  for (const altitude of [6500, 0, 25000, null]) {
    render()[1](current => ({ ...current, terrainAltitude: altitude }));
    render();
    assert.equal(restart()[0].terrainAltitude, altitude);
  }
  for (const altitude of [-100, 26000, '4500', false]) {
    storage.setItem(terrainKey, JSON.stringify({ version: 2, terrainAltitude: altitude }));
    assert.equal(restart()[0].terrainAltitude, null);
  }
});

test('terrain coverage persists while older or invalid preferences retain the route corridor', t => {
  const { render, restart, storage } = setup(t);
  render()[1](current => ({ ...current, terrainCoverage: 'viewport' }));
  render();
  assert.equal(restart()[0].terrainCoverage, 'viewport');
  for (const terrainCoverage of [undefined, null, true, 'unknown', 'route']) {
    storage.setItem(terrainKey, JSON.stringify({ version: 2, terrainCoverage, terrainAltitude: 4500 }));
    const restored = restart()[0];
    assert.equal(restored.terrainCoverage, 'route');
    assert.equal(restored.terrainAltitude, 4500);
  }
});

test('preferences save before another render and mounting never overwrites unknown records', t => {
  const unknown = JSON.stringify({ version: 99, chartBase: 'ifr-low', future: true });
  const { render, restart, storage } = setup(t, unknown);
  assert.equal(render()[0].chartBase, undefined);
  assert.equal(storage.getItem(key), unknown);
  render()[1](current => ({ ...current, chartBase: '', terrainCoverage: 'viewport', terrainAltitude: 0, metarEnabled: false }));
  const stored = JSON.parse(storage.getItem(terrainKey)!);
  assert.equal(storage.getItem(key), unknown, 'legacy records remain untouched');
  assert.equal(stored.version, 2);
  assert.equal(stored.terrainCoverage, 'viewport');
  assert.equal(stored.terrainAltitude, 0);
  assert.equal(restart()[0].metarEnabled, false, 'no render or effect is needed before reload');
});

test('changing one plugin preference cannot overwrite a newer choice saved by another window for another plugin', t => {
  const { render, restart, storage } = setup(t, JSON.stringify({ version: 2, chartBase: 'ifr-low', terrainEnabled: true }));
  const [, update] = render();
  const chartsKey = 'zlayer-plugin:charts:preferences';
  const external = JSON.stringify({ version: 2, chartBase: 'vfr-sectional', chartOverlay: '' });
  storage.setItem(chartsKey, external);
  update(current => ({ ...current, terrainEnabled: false }));
  assert.equal(storage.getItem(chartsKey), external, 'saving terrain leaves charts untouched');
  const restored = restart()[0];
  assert.equal(restored.chartBase, 'vfr-sectional');
  assert.equal(restored.terrainEnabled, false);
  assert.equal(JSON.parse(storage.getItem(terrainKey)!).chartBase, undefined, 'plugin records contain only their owner’s fields');
});
