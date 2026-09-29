import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';
import type { StartupStep } from '../src/workspace/startup';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { useStartup } = await import('../src/shell/use-startup');
loader.deregister();

function setup(t: test.TestContext) {
  const hooks = new Hooks(), frames = new Map<number, FrameRequestCallback>();
  t.after(() => hooks.unmount());
  let now = 0, id = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  for (const [key, value] of Object.entries({
    testHooks: hooks,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (handle: number) => frames.delete(handle),
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  let steps: StartupStep[] = [{ id: 'map', label: 'Map', state: 'loading' }];
  const render = () => hooks.render(() => useStartup(steps, false));
  const advance = (ms: number, deliverFrame = true) => {
    now += ms;
    t.mock.timers.tick(ms);
    if (deliverFrame) {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(now));
    }
    return render();
  };
  render();
  return { render, advance, frames, hooks, ready() {
    steps = [{ id: 'map', label: 'Map', state: 'ready' }];
    render(); return render();
  } };
}

test('ready startup releases despite sustained slow frames and never restarts', t => {
  const s = setup(t);
  assert.equal(s.advance(20_000).complete, false, 'a deadline cannot bypass pending data');
  s.ready();
  for (let i = 0; i < 14; i++) assert.equal(s.advance(100).complete, false);
  assert.equal(s.advance(100).complete, true, 'long frames cannot indefinitely disable a ready workspace');
  assert.equal(s.frames.size, 0);
  assert.equal(s.advance(20_000).complete, true);
});

test('ready startup also releases when animation callbacks are suspended', t => {
  const s = setup(t);
  s.ready();
  assert.equal(s.advance(1499, false).complete, false);
  assert.equal(s.advance(1, false).complete, true);
  assert.equal(s.frames.size, 0);
});

test('responsive startup retains its minimum visibility and releases before the fallback', t => {
  const s = setup(t);
  s.ready();
  for (let i = 0; i < 44; i++) assert.equal(s.advance(20).complete, false);
  assert.equal(s.advance(20).complete, true);
  assert.equal(s.frames.size, 0);
});

test('unmount cancels pending startup frames and release deadlines', t => {
  const s = setup(t);
  s.ready(); s.hooks.unmount();
  assert.equal(s.frames.size, 0);
  assert.equal(s.advance(20_000, false).complete, false);
});
