import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { LayerScope } from '../src/core/layers/scope';
import { createLayerInput } from '../src/core/layers/store';
import { MapLayerHost } from '../src/core/map/layer';
import { bindMapLayer } from '../src/core/map/contribution';
import { layerPlugins } from '../src/core/layers/plugin';
import { panelPlacement, validatePanelLayout } from '../src/core/layers/panel-layout';
import { PANEL_LAYOUT } from '../src/workspace/panel-layout';
import { pluginActivation, pluginContributions } from '../src/core/layers/activation';

test('dependency normalization follows prerequisites even when registration order is reversed', () => {
  const policy = pluginActivation([
    { definition: { id: 'tip', title: 'Tip' }, requires: ['left', 'right'] },
    { definition: { id: 'left', title: 'Left' }, requires: ['root'] },
    { definition: { id: 'right', title: 'Right' }, requires: ['root'] },
    { definition: { id: 'root', title: 'Root' } },
    { definition: { id: 'independent', title: 'Independent' } },
  ]);
  assert.deepEqual(policy.normalize(['root']), ['tip', 'left', 'right', 'root']);
  assert.deepEqual(policy.normalize(['left']), ['tip', 'left']);
  assert.deepEqual(policy.change(['root', 'independent'], 'tip', true), ['independent']);
});

test('inputs distinguish absent properties from own properties with undefined values', () => {
  const input = createLayerInput<Record<string, undefined>>();
  input.set({ first: undefined });
  let updates = 0;
  const stop = input.subscribe(() => updates++);
  input.set({ second: undefined });
  assert.deepEqual(input.getSnapshot(), { second: undefined });
  input.set({ second: undefined });
  assert.equal(updates, 1);
  stop();
});

test('loading restores prerequisites and unloading removes transitive dependents without touching other plugins', () => {
  const plugins = ['gps', 'ahrs', 'recorder', 'charts'].map(id => ({ definition: { id, title: id },
    ...(id === 'ahrs' ? { requires: ['gps'] } : id === 'recorder' ? { requires: ['ahrs'] } : {}) }));
  const policy = pluginActivation(plugins);
  assert.deepEqual(policy.change([], 'gps', false), ['gps', 'ahrs', 'recorder']);
  assert.deepEqual(policy.change(['gps', 'ahrs', 'recorder', 'charts'], 'recorder', true), ['charts']);
  assert.deepEqual(policy.normalize(['unknown', 'gps']), ['gps', 'ahrs', 'recorder']);
  assert.throws(() => pluginActivation([{ definition: { id: 'x', title: 'X' }, requires: ['missing'] }]), /Unknown plugin/);
  assert.throws(() => pluginActivation([{ definition: { id: 'x', title: 'X' }, requires: ['x'] }]), /dependency cycle/);
  assert.deepEqual(pluginContributions([]), { panels: [], controls: [], overlays: [], footer: [], mapContributions: [] });
});

test('scope aborts first and releases all owned work once, including failed and late cleanup', () => {
  const events: string[] = [];
  const scope = new LayerScope(error => events.push(String(error)));
  scope.add(() => { assert.equal(scope.signal.aborted, true); events.push('first'); });
  const dispose = scope.add(() => { events.push('second'); throw new Error('cleanup'); });
  scope.dispose(); scope.dispose(); dispose();
  scope.add(() => events.push('late'));
  assert.deepEqual(events, ['second', 'Error: cleanup', 'first', 'late']);
});

test('selected snapshots stay stable for active consumers and reset after the final unsubscribe', () => {
  const input = createLayerInput<{ value: number; title: string }>();
  input.set({ value: 1, title: 'initial' });
  const selected = input.select(({ value }) => ({ value }));
  let firstChanges = 0, secondChanges = 0;
  const first = selected.subscribe(() => firstChanges++);
  const second = selected.subscribe(() => secondChanges++);
  const snapshot = selected.getSnapshot();
  input.set({ value: 1, title: 'unrelated' });
  assert.equal(selected.getSnapshot(), snapshot);
  assert.equal(firstChanges, 0);
  assert.equal(secondChanges, 0);
  first(); first();
  assert.equal(selected.getSnapshot(), snapshot, 'another consumer still owns the cached snapshot');
  second();
  assert.notEqual(selected.getSnapshot(), snapshot, 'the final unsubscribe releases the cached snapshot');
  const stop = selected.subscribe(() => secondChanges++);
  input.set({ value: 2, title: 'reload' });
  assert.deepEqual(selected.getSnapshot(), { value: 2 });
  assert.equal(firstChanges, 0);
  assert.equal(secondChanges, 1, 'only the new subscription receives updates');
  stop();
});

test('map binding observes its inputs, ignores unrelated changes, and disconnects on failure/remount', () => {
  const values: number[] = [], errors: string[] = [];
  let mounts = 0, unmounts = 0;
  const input = createLayerInput<{ value: number; title: string }>();
  input.set({ value: 1, title: 'initial' });
  const binding = bindMapLayer({
    id: 'test', slot: 'weather',
    mount() { mounts++; },
    update(value: number) { if (value < 0) throw new Error('update'); values.push(value); },
    unmount() { unmounts++; },
  }, input.select(state => state.value));
  const host = new MapLayerHost({ getLayer: () => undefined } as unknown as MapLibreMap,
    (id, error) => errors.push(`${id}:${String(error)}`));
  host.mount([binding]);
  input.set({ value: 1, title: 'unrelated' });
  input.set({ value: 2, title: 'unrelated' });
  assert.deepEqual(values, [1, 2]);
  input.set({ value: -1, title: 'failed' });
  input.set({ value: 3, title: 'recovered data' });
  assert.deepEqual(values, [1, 2]);
  assert.deepEqual(errors, ['test:Error: update']);
  host.mount([binding]);
  assert.deepEqual(values, [1, 2, 3]);
  assert.equal(mounts, 2);
  host.unmount();
  input.set({ value: 4, title: 'after detach' });
  assert.deepEqual(values, [1, 2, 3]);
  assert.equal(unmounts, 2);
});

test('plugins reject duplicate identities and contribution IDs', () => {
  const plugin = { definition: { id: 'a', title: 'A' }, panels: [{ id: 'panel', title: 'Panel', Component: () => null }] };
  assert.throws(() => layerPlugins([plugin, plugin]), /Duplicate layer plugin/);
  assert.throws(() => layerPlugins([plugin, { ...plugin, definition: { id: 'b', title: 'B' } }]), /Duplicate layer contribution/);
});

test('host reserves current tab positions and rejects collisions or missing assignments', () => {
  validatePanelLayout(PANEL_LAYOUT);
  assert.deepEqual(PANEL_LAYOUT.gps, { side: 'left', tab: { edge: 'top', order: 1 } });
  assert.deepEqual(PANEL_LAYOUT.plate, { side: 'right', tab: { edge: 'bottom', order: 0 } });
  assert.equal(PANEL_LAYOUT.details.tab.order, 1);
  assert.deepEqual(PANEL_LAYOUT['weather-awc'], { side: 'left', tab: { edge: 'bottom', order: 1 }, bodyFromEdge: true });
  assert.throws(() => panelPlacement(PANEL_LAYOUT, 'unassigned'), /Missing panel placement/);
  assert.throws(() => validatePanelLayout({ ...PANEL_LAYOUT, other: PANEL_LAYOUT.gps }), /Panel slot collision/);
  assert.throws(() => validatePanelLayout({ other: { side: 'left', tab: { edge: 'top', order: -1 } } }), /Invalid panel placement/);
});

test('lazy map factories settle independently, isolate rejection, and discard a detached load', async () => {
  const { loadMapContribution } = await import('../src/core/map/contribution');
  const controller = new AbortController();
  const context = { map: {} as MapLibreMap, signal: controller.signal, preserveView: true,
    interactiveLayerIds: () => [], occupiedRects: () => [], targetBearing: () => 0, run(_id: string, action: () => void) { action(); }, reportError() {} };
  const events: string[] = [];
  let finish!: () => void;
  const delayed = new Promise<void>(resolve => { finish = resolve; });
  const module = (id: string) => ({ id, slot: 'route' as const,
    mount() { events.push(id); }, update() {}, unmount() {} });
  const slow = loadMapContribution({ id: 'slow', async load() { await delayed; return [module('slow')]; } }, context);
  const failed = loadMapContribution({ id: 'failed', load() { throw new Error('import failed'); } }, context);
  const fast = await loadMapContribution({ id: 'fast', async load() { return [module('fast')]; } }, context);
  assert.deepEqual(fast.map(value => value.id), ['fast'], 'a pending contribution does not block another');
  finish();
  const modules = [...await slow, ...await failed, ...fast];
  assert.deepEqual(modules.map(value => value.id), ['slow', 'failed', 'fast']);
  assert.deepEqual(events, [], 'loading must not mount or acquire resources');
  const errors: string[] = [];
  const host = new MapLayerHost({ getLayer: () => undefined } as unknown as MapLibreMap,
    (id, error) => errors.push(`${id}:${String(error)}`));
  host.mount(modules);
  assert.deepEqual(events, ['slow', 'fast']);
  assert.deepEqual(errors, ['failed:Error: import failed']);
  host.unmount();
  let release!: () => void;
  const detached = loadMapContribution({ id: 'late', async load() {
    await new Promise<void>(resolve => { release = resolve; }); return [module('late')];
  } }, context);
  await Promise.resolve();
  controller.abort(); release();
  assert.deepEqual(await detached, []);
  assert.deepEqual(events, ['slow', 'fast']);
  assert.deepEqual(await loadMapContribution({ id: 'cancelled', async load() {
    assert.fail('cancelled factories must not start');
  } }, context), []);
});


test('event-driven renderer failures release the owning attachment and leave other layers usable', () => {
  const errors: string[] = [], events: string[] = [];
  const input = createLayerInput<{ value: number }>(); input.set({ value: 1 });
  const failing = bindMapLayer({ id: 'route', slot: 'route', mount() {}, update() {},
    unmount() { events.push('released'); } }, input.select(state => state.value));
  const healthy = { id: 'healthy', slot: 'weather' as const, mount() {}, update() {}, unmount() {} };
  const host = new MapLayerHost({ getLayer: () => undefined } as unknown as MapLibreMap,
    (id, error) => errors.push(`${id}:${String(error)}`));
  host.mount([failing, healthy]);
  host.run('route', () => { throw new Error('drag render'); });
  host.run('route', () => events.push('must not run'));
  host.run('healthy', () => events.push('healthy'));
  host.unmount();
  assert.deepEqual(events, ['released', 'healthy']);
  assert.deepEqual(errors, ['route:Error: drag render']);
});


test('panel keyboard order follows the host layout, independent of plugin registration order', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { LayerPanels } = await import('../src/core/layers/panels');
  const order: string[] = [];
  const panels = ['terrain', 'ahrs', 'charts', 'gps'].map(id => ({ id, title: id,
    Component: () => { order.push(id); return null; } }));
  renderToStaticMarkup(createElement(LayerPanels, { panels, layout: PANEL_LAYOUT }));
  assert.deepEqual(order, ['charts', 'gps', 'ahrs', 'terrain']);
});
