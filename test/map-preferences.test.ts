import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { useMapPreferences } = await import('../src/shell/use-map-preferences');
loader.deregister();
const globals = globalThis as unknown as { testHooks: Hooks; window: unknown };
const key = 'zlayers-map-preferences-v1';

function setup(t: test.TestContext, initial?: string) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>(initial === undefined ? [] : [[key, initial]]);
  const storage = { getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  let hooks = new Hooks();
  const render = () => { globals.testHooks = hooks; return hooks.render(useMapPreferences); };
  t.after(() => {
    hooks.unmount();
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { storage, render, restart: () => { hooks.unmount(); hooks = new Hooks(); return render(); } };
}

test('map choices survive a fresh app mount, including false switches and base-map-only', t => {
  const { render, restart } = setup(t);
  const [defaults, setPreferences] = render();
  assert.equal(defaults.chartBase, undefined, 'first launch leaves automatic base selection intact');
  assert.equal(defaults.visibility.fixes, true, 'IFR fixes are enabled by default');
  assert.equal(defaults.terrainEnabled, true, 'terrain starts enabled without a saved preference');
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
  assert.deepEqual(render()[0], { chartBase: undefined, chartOverlay: '', metarEnabled: false, terrainEnabled: true, obstructionsEnabled: true, terrainAltitude: null, ownshipEnabled: true,
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
    storage.setItem(key, JSON.stringify({ terrainAltitude: altitude }));
    assert.equal(restart()[0].terrainAltitude, null);
  }
});
