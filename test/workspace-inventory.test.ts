import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import type { SavedBundleInventory } from '../src/offline/bundle-repository';
import { Hooks, hookModule } from './helpers/hooks';

const empty = (): SavedBundleInventory => ({ bundles: [], issues: [] });
const state = {
  restore: async (): Promise<SavedBundleInventory> => empty(),
  check: async (_bundles: unknown, _signal: AbortSignal): Promise<SavedBundleInventory> => empty(),
  notify: undefined as (() => void) | undefined,
};
Object.assign(globalThis, { workspaceInventoryTest: state });
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react') return { url: hookModule, shortCircuit: true };
  if (context.parentURL?.endsWith('/workspace/use-workspace-read-context.ts')) {
    const modules: Record<string, string> = {
      '../offline/bundle-repository': `
        export const restoreSavedBundleMetadata = () => globalThis.workspaceInventoryTest.restore();
        export const checkSavedBundleAvailability = (bundles, signal) => globalThis.workspaceInventoryTest.check(bundles, signal);
        export const retainFailedBundleOwnership = inventory => inventory.bundles;`,
      '../offline/inventory-events': `export const observeOfflineInventory = listener => {
        globalThis.workspaceInventoryTest.notify = listener;
        return () => { globalThis.workspaceInventoryTest.notify = undefined; };
      };`,
    };
    const source = modules[specifier];
    if (source) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  }
  return next(specifier, context);
} });
const { useWorkspaceReadContext } = await import('../src/workspace/use-workspace-read-context');
loader.deregister();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  state.restore = async () => empty();
  state.check = async () => empty();
  const hooks = new Hooks();
  Object.assign(globalThis, { testHooks: hooks });
  t.after(() => hooks.unmount());
  return { hooks, render: () => hooks.render(() => useWorkspaceReadContext(undefined)) };
}

test('inventory bursts refresh metadata promptly while health checks coalesce without overlapping', async t => {
  const { render } = fixture(t);
  const entered = deferred<AbortSignal>(), release = deferred<void>();
  let reads = 0, checks = 0, active = 0, peak = 0;
  state.restore = async () => ({ bundles: [], issues: ++reads === 1 ? [] : [{ message: 'Current inventory notice' }] });
  state.check = async (_bundles, signal) => {
    active++; peak = Math.max(peak, active);
    try {
      if (++checks === 1) { entered.resolve(signal); await release.promise; }
      signal.throwIfAborted();
      return empty();
    } finally { active--; }
  };
  render();
  const signal = await entered.promise;
  state.notify!(); state.notify!(); state.notify!();
  await settle();
  assert.equal(signal.aborted, true);
  assert.equal(reads, 2, 'metadata refresh must not wait behind the admitted health read');
  assert.match(render().error!, /Current inventory notice/);
  assert.equal(checks, 1);
  release.resolve();
  await settle();
  assert.equal(reads, 2);
  assert.equal(checks, 2);
  assert.equal(peak, 1);
  assert.match(render().error!, /Current inventory notice/);
});

test('a superseded metadata read skips health checking and publishes only the latest inventory', async t => {
  const { render } = fixture(t);
  const first = deferred<SavedBundleInventory>(), entered = deferred<void>();
  let reads = 0, checks = 0;
  state.restore = async () => {
    if (++reads === 1) { entered.resolve(); return first.promise; }
    return empty();
  };
  state.check = async () => { checks++; return empty(); };
  render();
  await entered.promise;
  state.notify!(); state.notify!();
  first.resolve({ bundles: [], issues: [{ message: 'Obsolete failure' }] });
  await settle();
  assert.equal(reads, 2);
  assert.equal(checks, 1);
  assert.equal(render().error, undefined);
});

test('unmount cancels the running check and drops a queued follow-up', async t => {
  const { hooks, render } = fixture(t);
  const entered = deferred<AbortSignal>(), release = deferred<void>();
  let reads = 0;
  state.restore = async () => { reads++; return empty(); };
  state.check = async (_bundles, signal) => {
    entered.resolve(signal); await release.promise; signal.throwIfAborted(); return empty();
  };
  render();
  const signal = await entered.promise;
  state.notify!();
  hooks.unmount();
  release.resolve();
  await settle();
  assert.equal(signal.aborted, true);
  assert.equal(state.notify, undefined);
  assert.equal(reads, 1);
});
