import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';
import { isBoolean } from '../src/core/storage/ui-state';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { usePersistentState } = await import('../src/core/ui/use-persistent-state');
loader.deregister();

test('UI actions save synchronously, including close, without mount defaults overwriting storage', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  let hooks = new Hooks();
  const render = (key = 'panel') => {
    Object.assign(globalThis, { testHooks: hooks });
    return hooks.render(() => usePersistentState(key, false, isBoolean));
  };
  const restart = () => { hooks.unmount(); hooks = new Hooks(); return render(); };
  assert.equal(render()[0], false);
  assert.equal(values.size, 0, 'mounting defaults is read-only');
  render()[1](true);
  assert.equal(restart()[0], true, 'no intervening React render/effect is needed');
  render()[1](value => !value);
  assert.equal(restart()[0], false, 'an explicit close survives refresh');
  values.set('zlayer-ui:panel', '{broken');
  assert.equal(restart()[0], false);
  assert.equal(values.get('zlayer-ui:panel'), '{broken');
  values.set('zlayer-ui:panel', JSON.stringify({ version: 2, value: true }));
  assert.equal(restart()[0], false);
  storage.setItem = () => { throw new Error('quota'); };
  render()[1](true);
  assert.equal(render()[0], true, 'storage failures do not disable session changes');
  assert.equal(render('other-panel')[0], false, 'changing identities cannot leak another panel state');
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
  assert.equal(restart()[0], false);
});

test('a callback from a previous storage key cannot mix two panels or overwrite their saved state', t => {
  const values = new Map<string, string>();
  const hooks = new Hooks();
  for (const [name, value] of Object.entries({ testHooks: hooks, window: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  t.after(() => hooks.unmount());
  const render = (key: string) => hooks.render(() => usePersistentState(key, 0,
    (value): value is number => typeof value === 'number'));
  const oldUpdate = render('first')[1];
  oldUpdate(5);
  render('second')[1](20);
  oldUpdate(value => value + 1);
  assert.equal(render('second')[0], 20);
  assert.equal(render('first')[0], 5, 'an obsolete callback must not write the second panel value into the first');
  render('first')[1](value => value + 1);
  render('first')[1](value => value + 1);
  assert.equal(render('first')[0], 7, 'current functional updates still compose synchronously');
  assert.equal(JSON.parse(values.get('zlayer-ui:first')!).value, 7);
  assert.equal(JSON.parse(values.get('zlayer-ui:second')!).value, 20);
});
