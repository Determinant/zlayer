import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Hooks, hookModule } from './helpers/hooks';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { useEditorGestures } = await import('../src/layers/routes/use-editor-gestures');
loader.deregister();

function setup(t: test.TestContext) {
  const hooks = new Hooks();
  Object.assign(globalThis, { testHooks: hooks });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const timers = new Map<number, () => void>();
  globalThis.window = { setTimeout: (fn: () => void) => { timers.set(1, fn); return 1; },
    clearTimeout: (id: number) => timers.delete(id) } as unknown as Window & typeof globalThis;
  globalThis.document = new EventTarget() as unknown as Document;
  let captured = false;
  const element = { setPointerCapture() { captured = true; }, hasPointerCapture: () => captured,
    releasePointerCapture() { captured = false; }, getBoundingClientRect: () => ({ left: 0 }) };
  const event = (clientX: number, pointerType = 'mouse') => ({ button: 0, pointerId: 1, pointerType,
    clientX, clientY: 0, currentTarget: element, preventDefault() {} }) as unknown as ReactPointerEvent<HTMLButtonElement>;
  const moves: [string, string][] = [];
  const render = (key = 1) => hooks.render(() => useEditorGestures(key, (from, to) => moves.push([from, to])));
  let gestures = render();
  gestures.editorRef.current = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 0, right: 500 }),
    querySelectorAll: () => [0, 1].map(index => ({ dataset: { routeEntry: String(index) }, offsetWidth: 20,
      getBoundingClientRect: () => ({ left: index * 100 }) })) } as unknown as HTMLDivElement;
  t.after(() => { hooks.unmount(); globalThis.window = originalWindow; globalThis.document = originalDocument; });
  return { render, event, moves, timers, hooks, captured: () => captured, element: element as unknown as HTMLButtonElement };
}

test('a token drag commits once and pointer cancellation never moves the draft', t => {
  const { render, event, moves, captured } = setup(t);
  for (const cancelled of [true, false]) {
    const gestures = render();
    gestures.beginPointer(event(10), '0', 'A');
    gestures.movePointer(event(110));
    gestures.finishPointer(event(110), cancelled);
    gestures.finishPointer(event(110), false);
    assert.equal(captured(), false);
    assert.equal(render().drag, undefined);
    assert.deepEqual(moves, cancelled ? [] : [['0', '1']]);
  }
});

test('replacing same-length route tokens cancels old menus, drags and long presses', t => {
  const { render, event, moves, timers, captured, element } = setup(t);
  let gestures = render();
  gestures.openMenu('0', 'A', element);
  assert.equal(render().menu?.ident, 'A');
  gestures.beginPointer(event(10, 'touch'), '0', 'A');
  assert.equal(timers.size, 1);
  gestures = render(2);
  assert.equal(gestures.menu, undefined);
  assert.equal(captured(), false);
  assert.equal(timers.size, 0);
  gestures.movePointer(event(110, 'touch'));
  gestures.finishPointer(event(110, 'touch'), false);
  assert.deepEqual(moves, []);

  gestures.beginPointer(event(10), '0', 'C');
  gestures.movePointer(event(110));
  assert.ok(render(2).drag);
  gestures = render(3);
  gestures.finishPointer(event(110), false);
  assert.deepEqual(moves, []);
  assert.equal(render(3).drag, undefined);
});

test('unmount releases pointer capture and cancels a pending long press', t => {
  const { render, event, timers, captured, hooks } = setup(t);
  render().beginPointer(event(10, 'touch'), '0', 'A');
  assert.equal(captured(), true);
  hooks.unmount();
  assert.equal(captured(), false);
  assert.equal(timers.size, 0);
});
