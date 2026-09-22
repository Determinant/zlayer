import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { emptyRoutePlan } from '@zlayer/domain';
import type { RoutePlan } from '@zlayer/domain';
import type { CatalogReadSource } from '../src/workspace/read-context';
import type { MapContributionContext } from '../src/core/map/contribution';
import { PluginRegistry, PluginScope } from '../src/core/layers/bridge';
import { createRoutesPlugin } from '../src/layers/routes/plugin';
import { createTerrainPlugin } from '../src/layers/terrain/plugin';
import { createObstructionsPlugin } from '../src/layers/obstructions/plugin';
import type { WorkspacePluginApis } from '../src/workspace/plugin-apis';

// Exercise actual plugin connections and map bindings; substitute only GPU/worker adapters.
const adapterModule = (name: string) => 'data:text/javascript,' + encodeURIComponent(`
export function ${name}() { return { id: 'probe', slot: 'terrain', mount() {}, unmount() {},
  update(input) {
    if (globalThis.pluginFailUpdate) { globalThis.pluginFailUpdate = false; throw new Error('renderer failed'); }
    globalThis.pluginInputs.push(input);
  } }; }
`);

test('terrain and obstructions discover late routes, follow previews, clear on unload and recover without duplicate listeners', async t => {
  const loader = registerHooks({ resolve(specifier, context, next) {
    if (specifier === './map' && context.parentURL?.endsWith('/terrain/plugin.tsx')) {
      return { url: adapterModule('createTerrainLayer'), shortCircuit: true };
    }
    if (specifier === './map' && context.parentURL?.endsWith('/obstructions/plugin.tsx')) {
      return { url: adapterModule('createObstructionLayer'), shortCircuit: true };
    }
    return next(specifier, context);
  } });
  t.after(() => loader.deregister());
  const updates: Array<{ routes: readonly RoutePlan[] }> = [];
  Object.assign(globalThis, { pluginInputs: updates });
  t.after(() => Reflect.deleteProperty(globalThis, 'pluginInputs'));
  const registry = new PluginRegistry<WorkspacePluginApis>();
  const routes = createRoutesPlugin(), terrain = createTerrainPlugin(), obstructions = createObstructionsPlugin();
  const registrations = {
    routes: registry.registration('routes', routes), terrain: registry.registration('terrain', terrain),
    obstructions: registry.registration('obstructions', obstructions),
  };
  const plan = emptyRoutePlan(), preview = emptyRoutePlan();
  const displayedRoutes = [plan, preview];
  routes.input.set({ route: plan, routePreview: undefined, displayedRoutes, focusNonce: 0,
    actions: { insert() {}, replace() {}, remove() {} },
  });
  terrain.input.set({ enabled: true, catalog: {} as CatalogReadSource, altitude: null, coverage: 'route',
    onToggle() {}, onAltitudeChange() {}, onCoverageChange() {},
  });
  obstructions.input.set({ enabled: true, onToggle() {} });
  registrations.terrain.activate(); registrations.obstructions.activate();
  const context = {} as MapContributionContext;
  const bindings = [...await terrain.mapContribution.load(), ...await obstructions.mapContribution.load()];
  for (const binding of bindings) {
    binding.mount(context.map);
    t.after(binding.subscribeInputs!(() => binding.update()));
  }
  assert.equal(updates.length, 2);
  assert.ok(updates.every(input => input.routes.length === 0));
  updates.length = 0;
  registrations.routes.activate();
  assert.equal(updates.length, 2);
  assert.ok(updates.every(input => input.routes === displayedRoutes));
  updates.length = 0;
  routes.input.set({ ...routes.input.require(), focusNonce: 1 });
  assert.equal(updates.length, 0, 'camera commands do not redraw terrain or obstructions');
  terrain.input.set({ ...terrain.input.require(), onToggle() {} });
  obstructions.input.set({ ...obstructions.input.require(), onToggle() {} });
  assert.equal(updates.length, 0, 'changing UI callbacks does not redraw terrain or obstructions');
  for (let cycle = 0; cycle < 4; cycle++) {
    registrations.routes.deactivate();
    assert.equal(updates.length, 2);
    assert.ok(updates.every(input => input.routes.length === 0));
    updates.length = 0;
    registrations.routes.activate();
    assert.equal(updates.length, 2);
    assert.ok(updates.every(input => input.routes === displayedRoutes));
    updates.length = 0;
  }
  registrations.terrain.deactivate(); registrations.obstructions.deactivate();
  updates.length = 0;
  routes.input.set({ ...routes.input.require(), displayedRoutes: [preview] });
  assert.equal(updates.length, 0, 'disabled consumers no longer observe route changes');
  registrations.terrain.activate(); registrations.obstructions.activate();
  assert.equal(updates.length, 2);
  assert.ok(updates.every(input => input.routes === routes.input.require().displayedRoutes));
  registrations.routes.deactivate(); registrations.terrain.deactivate(); registrations.obstructions.deactivate();
});

test('a retained route editing command cannot act after renderer detach, including after remount', async t => {
  const loader = registerHooks({ resolve(specifier, context, next) {
    if (specifier === './layer' && context.parentURL?.endsWith('/routes/map-contribution.ts')) {
      return { url: adapterModule('createRouteLayer'), shortCircuit: true };
    }
    return next(specifier, context);
  } });
  t.after(() => loader.deregister());
  const updates: unknown[] = [];
  Object.assign(globalThis, { pluginInputs: updates });
  t.after(() => Reflect.deleteProperty(globalThis, 'pluginInputs'));
  const routes = createRoutesPlugin(), route = emptyRoutePlan();
  routes.input.set({ route, routePreview: undefined, focusNonce: 0,
    actions: { insert() {}, replace() {}, remove() {} },
  });
  let detach = () => {};
  const failures: unknown[] = [];
  const context: MapContributionContext = {
    map: {} as MapContributionContext['map'], signal: new AbortController().signal, preserveView: true,
    interactiveLayerIds: () => [], occupiedRects: () => [], targetBearing: () => 0,
    reportError(error) { throw error; }, run(_id, action) {
      try { action(); } catch (error) { failures.push(error); detach(); }
    },
  };
  const [adapter] = await routes.mapContribution.load(context);
  detach = () => adapter!.unmount();
  adapter!.mount({} as MapContributionContext['map']);
  const old = routes.editing.getSnapshot()!;
  old({ route });
  adapter!.unmount();
  assert.equal(routes.editing.getSnapshot(), undefined);
  assert.throws(() => old({ route }), /no longer available/);
  adapter!.mount({} as MapContributionContext['map']);
  const count = updates.length;
  assert.throws(() => old({ route }), /no longer available/);
  assert.equal(updates.length, count);
  routes.editing.getSnapshot()!({ route });
  assert.equal(updates.length, count + 1);
  Object.assign(globalThis, { pluginFailUpdate: true });
  assert.doesNotThrow(() => routes.editing.getSnapshot()!({ route }), 'handled renderer failure must not become a second command error');
  assert.equal(failures.length, 1);
  assert.equal(routes.editing.getSnapshot(), undefined);
  Reflect.deleteProperty(globalThis, 'pluginFailUpdate');
  adapter!.unmount();
});

test('public route edits follow current inputs and are revoked when their provider is unloaded', () => {
  const routes = createRoutesPlugin();
  const registry = new PluginRegistry<WorkspacePluginApis>();
  const registration = registry.registration('routes', routes);
  const edits: string[] = [];
  const input = { route: emptyRoutePlan(), routePreview: undefined, focusNonce: 0,
    actions: { insert() {}, replace() {}, remove: (id: string) => edits.push(id) } };
  routes.input.set(input);
  registration.activate();
  const scope = new PluginScope();
  const bridge = registry.forScope(scope);
  try {
    const old = bridge.get('routes')!;
    old.actions.remove('first');
    routes.input.set({ ...input, actions: { ...input.actions, remove: id => edits.push(`new:${id}`) } });
    old.actions.remove('second');
    registration.deactivate();
    assert.throws(() => old.actions.remove('stale'), /no longer available/);
    registration.activate();
    assert.throws(() => old.actions.remove('stale'), /no longer available/);
    bridge.get('routes')!.actions.remove('third');
    assert.deepEqual(edits, ['first', 'new:second', 'new:third']);
  } finally { scope.dispose(); registration.deactivate(); }
});
