import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
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
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  globalThis.window = Object.assign(new EventTarget(), {
    setTimeout: (fn: () => void) => { timers.set(1, fn); return 1; }, clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }) as unknown as Window & typeof globalThis;
  globalThis.document = new EventTarget() as unknown as Document;
  let captured = false;
  const element = { setPointerCapture() { captured = true; }, hasPointerCapture: () => captured,
    releasePointerCapture() { captured = false; }, closest: () => null,
    getBoundingClientRect: () => ({ left: 0, width: 20 }) };
  const event = (clientX: number, pointerType = 'mouse') => ({ button: 0, pointerId: 1, pointerType,
    clientX, clientY: 20, currentTarget: element, target: element, preventDefault() {} }) as unknown as ReactPointerEvent<HTMLButtonElement>;
  const click = (detail = 1) => ({ detail, currentTarget: element, preventDefault() {}, stopPropagation() {} }) as unknown as ReactMouseEvent<HTMLButtonElement>;
  const moves: [string, string][] = [];
  const render = (key = 1) => hooks.render(() => useEditorGestures(key, (from, to) => moves.push([from, to])));
  let gestures = render();
  gestures.editorRef.current = { scrollLeft: 0, scrollWidth: 1000, clientWidth: 500,
    getBoundingClientRect: () => ({ left: 0, right: 500, top: 0, bottom: 44 }),
    querySelectorAll: () => [0, 1].map(index => ({ dataset: { routeEntry: String(index) }, offsetWidth: 20,
      getBoundingClientRect: () => ({ left: index * 100 }) })) } as unknown as HTMLDivElement;
  t.after(() => { hooks.unmount(); globalThis.window = originalWindow; globalThis.document = originalDocument; });
  const hold = () => { for (const fn of [...timers.values()]) fn(); };
  const frame = (time: number) => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time));
  };
  return { render, event, click, moves, timers, frames, frame, hold, hooks, captured: () => captured, element: element as unknown as HTMLButtonElement };
}

test('a token drag commits once and pointer cancellation never moves the draft', t => {
  const { render, event, moves, captured, hold } = setup(t);
  for (const cancelled of [true, false]) {
    const gestures = render();
    gestures.beginPointer(event(10), '0');
    hold();
    gestures.movePointer(event(110));
    gestures.finishPointer(event(110), cancelled);
    gestures.finishPointer(event(110), false);
    assert.equal(captured(), false);
    assert.equal(render().drag, undefined);
    assert.deepEqual(moves, cancelled ? [] : [['0', '1']]);
  }
});

test('a wide approach bundle drops on the entry under the pointer', t => {
  const { render, event, hold, moves, element } = setup(t);
  const gestures = render();
  const bundle = { dataset: { routeEntry: '0' }, offsetWidth: 300,
    getBoundingClientRect: () => ({ left: 0, width: 300 }) };
  t.mock.method(element, 'closest', () => bundle);
  gestures.editorRef.current!.querySelectorAll = (() => [bundle, {
    dataset: { routeEntry: '1' }, offsetWidth: 60, getBoundingClientRect: () => ({ left: 304 }),
  }]) as unknown as HTMLDivElement['querySelectorAll'];
  gestures.beginPointer(event(290), '0');
  hold();
  assert.equal(render().drag?.targetId, '0');
  gestures.movePointer(event(330));
  assert.equal(render().drag?.targetId, '1');
  gestures.finishPointer(event(330), false);
  assert.deepEqual(moves, [['0', '1']]);
});

test('replacing same-length route tokens cancels old menus, drags and long presses', t => {
  const { render, event, moves, timers, captured, element, hold } = setup(t);
  let gestures = render();
  gestures.openMenu('0', 'A', element);
  assert.equal(render().menu?.ident, 'A');
  gestures.beginPointer(event(10, 'touch'), '0');
  assert.equal(timers.size, 1);
  gestures = render(2);
  assert.equal(gestures.menu, undefined);
  assert.equal(captured(), false);
  assert.equal(timers.size, 0);
  gestures.movePointer(event(110, 'touch'));
  gestures.finishPointer(event(110, 'touch'), false);
  assert.deepEqual(moves, []);

  gestures.beginPointer(event(10), '0');
  hold();
  gestures.movePointer(event(110));
  assert.ok(render(2).drag);
  gestures = render(3);
  gestures.finishPointer(event(110), false);
  assert.deepEqual(moves, []);
  assert.equal(render(3).drag, undefined);
});

test('unmount releases a held token and stops edge scrolling', t => {
  const { render, event, timers, frames, hold, captured, hooks } = setup(t);
  render().beginPointer(event(10, 'touch'), '0');
  assert.equal(captured(), false, 'pending touches leave native scrolling available');
  hold();
  assert.equal(captured(), true);
  hooks.unmount();
  assert.equal(captured(), false);
  assert.equal(timers.size, 0);
  assert.equal(frames.size, 0);
});

test('a touch swipe stays a scroll after pausing and cannot activate the token on release', t => {
  const { render, event, click, hold, timers, moves, captured } = setup(t);
  const gestures = render();
  gestures.beginPointer(event(10, 'touch'), '0');
  gestures.movePointer(event(110, 'touch'));
  assert.equal(timers.size, 0);
  hold();
  gestures.movePointer(event(210, 'touch'));
  assert.equal(render().drag, undefined);
  assert.equal(captured(), false);
  gestures.finishPointer(event(210, 'touch'), false);
  gestures.clickToken(click(), '0', 'A');
  assert.equal(render().menu, undefined);
  assert.deepEqual(moves, []);
  // A fresh tap and keyboard activation both remain available after scrolling.
  gestures.beginPointer(event(10, 'touch'), '0');
  gestures.finishPointer(event(10, 'touch'), false);
  gestures.clickToken(click(), '0', 'A');
  assert.equal(render().menu?.ident, 'A');
  gestures.clickToken(click(0), '1', 'B');
  assert.equal(render().menu?.ident, 'B');
});

test('a mouse pan stays a scroll after pausing, clamps to the route, and suppresses the release click', t => {
  const { render, event, click, hold, timers, moves, captured } = setup(t);
  const gestures = render(), editor = gestures.editorRef.current!;
  editor.scrollLeft = 100;
  gestures.beginPointer(event(310), '0');
  gestures.movePointer(event(210));
  assert.equal(editor.scrollLeft, 200);
  assert.equal(render().scrolling, true);
  assert.equal(timers.size, 0);
  hold();
  gestures.movePointer(event(-1000));
  assert.equal(editor.scrollLeft, 500);
  gestures.movePointer(event(1000));
  assert.equal(editor.scrollLeft, 0);
  assert.equal(render().drag, undefined);
  gestures.finishPointer(event(1000), false);
  assert.equal(captured(), false);
  assert.equal(render().scrolling, false);
  let stopped = false;
  gestures.captureClick({ ...click(), stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  gestures.clickToken(click(), '0', 'A');
  assert.equal(render().menu, undefined);
  assert.deepEqual(moves, []);

  gestures.beginPointer(event(10), '0');
  gestures.finishPointer(event(10), false);
  gestures.clickToken(click(), '0', 'A');
  assert.equal(render().menu?.ident, 'A');
});

test('strip gaps scroll without arming a reorder, and a fresh click is allowed', t => {
  const { render, event, click, hold, timers, moves } = setup(t);
  const gestures = render();
  gestures.beginPointer(event(210));
  assert.equal(timers.size, 0);
  hold();
  gestures.movePointer(event(10));
  assert.equal(gestures.editorRef.current!.scrollLeft, 200);
  gestures.finishPointer(event(10), false);
  assert.deepEqual(moves, []);
  gestures.beginPointer(event(10));
  gestures.finishPointer(event(10), false);
  gestures.captureClick({ ...click(), stopPropagation: () => assert.fail('fresh clicks must be allowed') });
});

test('Escape cancels mouse panning and prevents later pointer movement or clicks from editing', t => {
  const { render, event, click, moves, captured } = setup(t);
  const gestures = render();
  gestures.beginPointer(event(210), '0');
  gestures.movePointer(event(110));
  document.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
  gestures.movePointer(event(10));
  gestures.finishPointer(event(10), false);
  gestures.clickToken(click(), '0', 'A');
  assert.equal(gestures.editorRef.current!.scrollLeft, 100);
  assert.equal(captured(), false);
  assert.equal(render().scrolling, false);
  assert.equal(render().menu, undefined);
  assert.deepEqual(moves, []);
});

test('holding lifts a token, suppresses its context menu, and reorders only after movement', t => {
  const { render, event, click, hold, element, moves } = setup(t);
  const gestures = render();
  gestures.beginPointer(event(10, 'touch'), '0');
  hold();
  assert.equal(render().drag?.sourceId, '0');
  gestures.openMenu('0', 'A', element);
  assert.equal(render().menu, undefined);
  gestures.finishPointer(event(10, 'touch'), false);
  gestures.clickToken(click(), '0', 'A');
  assert.deepEqual(moves, []);
  assert.equal(render().menu, undefined);

  gestures.beginPointer(event(10, 'touch'), '0');
  hold();
  gestures.movePointer(event(110, 'touch'));
  gestures.finishPointer(event(110, 'touch'), false);
  gestures.clickToken(click(), '0', 'A');
  assert.deepEqual(moves, [['0', '1']]);
  assert.equal(render().menu, undefined);
});

test('edge scrolling continues with a stationary finger and stops when cancelled', t => {
  const { render, event, hold, frame, frames, moves } = setup(t);
  const gestures = render();
  gestures.beginPointer(event(10, 'touch'), '0');
  hold();
  gestures.movePointer(event(495, 'touch'));
  frame(0); frame(16); frame(32);
  const first = gestures.editorRef.current!.scrollLeft;
  assert.ok(first > 0);
  frame(48); frame(64);
  assert.ok(gestures.editorRef.current!.scrollLeft > first);
  gestures.finishPointer(event(495, 'touch'), true);
  assert.equal(frames.size, 0);
  assert.deepEqual(moves, []);
});

test('a second finger, focus loss, or a new revision cancels an armed reorder', t => {
  const { render, event, hold, moves, frames, captured } = setup(t);
  for (const reason of ['second finger', 'blur', 'revision']) {
    const gestures = render();
    gestures.beginPointer(event(10, 'touch'), '0');
    hold();
    gestures.movePointer(event(110, 'touch'));
    if (reason === 'second finger') document.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 2 }));
    else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    else render(2);
    gestures.finishPointer(event(110, 'touch'), false);
    assert.equal(captured(), false);
    assert.equal(frames.size, 0);
    assert.deepEqual(moves, []);
    assert.equal(render().drag, undefined);
  }
});
