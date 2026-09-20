import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { useMapView } = await import('../src/shell/use-map-view');
loader.deregister();
const globals = globalThis as unknown as { testHooks: Hooks; window: unknown };
const key = 'zlayers-map-view-v1';

function setup(t: test.TestContext, initial?: string) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>(initial === undefined ? [] : [[key, initial]]);
  const storage = { getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  let hooks = new Hooks();
  const render = () => { globals.testHooks = hooks; return hooks.render(useMapView); };
  t.after(() => {
    hooks.unmount();
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { storage, render, restart: () => { hooks.unmount(); hooks = new Hooks(); return render(); } };
}

test('map camera is saved synchronously without requiring another render', t => {
  const { render, restart } = setup(t);
  const [defaults, setView] = render();
  assert.equal(defaults, undefined);
  const chosen = { center: [241.7563, 34.0522] as [number, number], zoom: 8.25, bearing: 30, pitch: 40 };
  setView(chosen);
  assert.deepEqual(restart()[0], chosen);
});

test('invalid or unavailable map view storage falls back safely', t => {
  const { render, restart, storage } = setup(t, JSON.stringify({ version: 1, center: [-118, 34], zoom: 8 }));
  assert.deepEqual(render()[0], { center: [-118, 34], zoom: 8, bearing: 0, pitch: 0 });
  for (const value of ['{broken', 'null', JSON.stringify({ version: 1, center: [-118, 91], zoom: 8 }),
    JSON.stringify({ version: 1, center: [-118, 34], zoom: 14 }), JSON.stringify({ version: 2, center: [-118, 34], zoom: 8 })]) {
    storage.setItem(key, value);
    assert.equal(restart()[0], undefined);
  }
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied'); } });
  assert.equal(restart()[0], undefined);
});
