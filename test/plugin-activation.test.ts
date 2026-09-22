import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { usePlugins } = await import('../src/core/layers/use-plugins');
loader.deregister();

test('unload releases dependents once, reload restores contributions, and saved intent survives restart', () => {
  const saved = new Map<string, string>();
  Object.assign(globalThis, { window: { localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  } } });
  const events: string[] = [];
  const plugins = ['ahrs', 'gps', 'charts'].map(id => ({ definition: { id, title: id },
    ...(id === 'ahrs' ? { requires: ['gps'] } : {}), dispose() { events.push(id); },
    controls: [{ id, Component: () => null }],
  }));
  const hooks = new Hooks(); Object.assign(globalThis, { testHooks: hooks });
  const render = () => hooks.render(() => usePlugins(plugins));
  let state = render();
  assert.equal(saved.size, 0, 'startup does not overwrite saved intent');
  state.setLoaded('gps', false);
  assert.deepEqual(JSON.parse(saved.get('zlayer-ui:plugins-unloaded')!).value, ['ahrs', 'gps'], 'persist at action time');
  state = render(); render();
  assert.deepEqual(events, ['ahrs', 'gps']);
  assert.deepEqual(state.controls.map(control => control.id), ['charts']);
  state.setLoaded('ahrs', true); state = render();
  assert.deepEqual(state.controls.map(control => control.id), ['ahrs', 'gps', 'charts']);
  state.setLoaded('charts', false); render();
  hooks.unmount();
  assert.deepEqual(events, ['ahrs', 'gps', 'charts', 'ahrs', 'gps']);
  const restart = new Hooks(); Object.assign(globalThis, { testHooks: restart });
  const restored = restart.render(() => usePlugins(plugins));
  assert.equal(restored.isLoaded('charts'), false);
  assert.equal(restored.isLoaded('ahrs'), true);
  restart.unmount();
  Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'testHooks');
});
