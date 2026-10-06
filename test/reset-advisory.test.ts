import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ResetAdvisories, isResetAdvisory } from '../src/reset-advisory';

function storage(t: TestContext) {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : Reflect.deleteProperty(globalThis, 'localStorage'));
  return values;
}

test('fresh installs consume the current advisory quietly, including after saving data and reloading', async t => {
  storage(t);
  const fresh = new ResetAdvisories();
  assert.equal(await fresh.startup('artcc-2026-10', async () => false), false);
  assert.equal(await new ResetAdvisories().startup('artcc-2026-10', async () => true), false);
});

test('legacy saved data prompts once across reloads and windows, and future IDs remain independent', async t => {
  storage(t);
  const windows = [new ResetAdvisories(), new ResetAdvisories()];
  assert.deepEqual(await Promise.all(windows.map(window => window.startup('artcc-2026-10', async () => true))), [true, false]);
  assert.equal(await new ResetAdvisories().startup('artcc-2026-10', async () => true), false);
  assert.equal(await new ResetAdvisories().startup('next-format', async () => true), true);
  assert.equal(await new ResetAdvisories().claim('artcc-2026-10'), false, 're-enabling an old ID does not repeat it');
});

test('disabled releases do not inspect data or consume a later advisory', async t => {
  const values = storage(t);
  assert.equal(await new ResetAdvisories().startup(undefined, async () => { throw new Error('Unexpected read'); }), false);
  assert.equal(values.size, 0);
  assert.equal(await new ResetAdvisories().claim('later-format'), true);
});

test('denied storage retains session-only dismissal without blocking the update', async t => {
  storage(t);
  t.mock.method(localStorage, 'setItem', () => { throw new Error('Storage denied'); });
  const advisory = new ResetAdvisories();
  assert.equal(await advisory.claim('format'), true);
  assert.equal(await advisory.claim('format'), false);
});

test('only bounded identifier strings are accepted from release metadata', () => {
  for (const value of ['artcc-2026-10', 'future-v2']) assert.equal(isResetAdvisory(value), true);
  for (const value of [null, undefined, '', {}, 'a'.repeat(81), '<b>reset</b>', 'two words']) assert.equal(isResetAdvisory(value), false);
});
