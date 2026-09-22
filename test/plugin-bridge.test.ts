import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginRegistry, PluginScope, PluginUnavailableError } from '../src/core/layers/bridge';
import { createLayerStore, type LayerStore } from '../src/core/layers/store';
import { createLayerInput, selectLayerStore, combineLayerStores } from '../src/core/layers/input';
import { createLayerEvents, type LayerEvents } from '../src/core/layers/events';

type Api = { state: LayerStore<number>; increment(): void; events: LayerEvents<number> };
type Apis = { counter: Api; unrelated: object };
function setup() {
  const errors: unknown[] = [];
  const registry = new PluginRegistry<Apis>(error => errors.push(error));
  const owner = new PluginScope(error => errors.push(error)), bridge = registry.forScope(owner);
  const state = createLayerStore(0), events = createLayerEvents<number>();
  let subscribers = 0;
  const observed: LayerStore<number> = { getSnapshot: state.getSnapshot, subscribe(listener) {
    subscribers++;
    const stop = state.subscribe(listener);
    return () => { subscribers--; stop(); };
  } };
  const provider = registry.registration('counter', { publicApi: scope => ({ state: scope.store(observed),
    increment: scope.command(() => state.publish(state.getSnapshot() + 1)),
    events: { subscribe: listener => scope.listen(events.events, listener) },
  }) });
  return { registry, owner, bridge, state, events, provider, errors, subscribers: () => subscribers };
}

test('lookup is optional and workspace-local; only the watched ID changes a connection', () => {
  const s = setup(), values: Array<number | undefined> = [];
  s.bridge.watch('counter', api => values.push(api?.state.getSnapshot()));
  assert.deepEqual(values, [undefined]);
  assert.equal(s.bridge.get('counter'), undefined);
  s.provider.activate();
  const api = s.bridge.get('counter')!;
  assert.equal(api, s.bridge.get('counter'));
  assert.equal(setup().bridge.get('counter'), undefined);
  s.registry.registration('unrelated', { publicApi: () => ({}) }).activate();
  api.increment();
  assert.deepEqual(values, [undefined, 0], 'state and unrelated providers do not reconnect');
  assert.throws(() => s.registry.registration('counter', { publicApi: () => api }).activate(), /Duplicate/);
  s.provider.deactivate();
  assert.deepEqual(values, [undefined, 0, undefined]);
  assert.throws(api.increment, PluginUnavailableError);
  s.owner.dispose();
  assert.equal(s.bridge.get('counter'), undefined);
  assert.deepEqual(s.errors, []);
});

test('late consumers get current data; both provider and consumer teardown release subscriptions', () => {
  const s = setup(), values: number[] = [];
  s.state.publish(42); s.provider.activate();
  const stop = s.bridge.watch('counter', (api, scope) => { if (api) scope.observe(api.state, value => values.push(value)); });
  assert.deepEqual(values, [42]);
  assert.equal(s.subscribers(), 1);
  for (let i = 0; i < 30; i++) {
    s.provider.deactivate();
    assert.equal(s.subscribers(), 0);
    s.state.publish(i);
    s.provider.activate();
    assert.equal(s.subscribers(), 1);
    assert.equal(values.at(-1), i);
  }
  stop(); stop();
  assert.equal(s.subscribers(), 0);
  s.bridge.watch('counter', (api, scope) => { if (api) scope.observe(api.state, () => {}); });
  assert.equal(s.subscribers(), 1);
  s.owner.dispose(); s.owner.dispose();
  assert.equal(s.subscribers(), 0);
  s.provider.deactivate(); s.provider.activate();
  assert.equal(s.subscribers(), 0);
  assert.deepEqual(s.errors, []);
});

test('workspace recovery retries only failed scoped watches and preserves plugin connections', () => {
  const s = setup(), values: number[] = [];
  const recovery = s.registry.scopedConnections;
  let fail = true, attempts = 0, healthyConnections = 0, pluginAttempts = 0;
  s.provider.activate();
  const api = s.bridge.get('counter');
  s.bridge.watch('counter', (api, scope) => {
    if (!api) return;
    attempts++;
    scope.observe(api.state, value => { if (fail) throw new Error('workspace connection'); values.push(value); });
  });
  s.bridge.watch('counter', (api, scope) => {
    if (api) { healthyConnections++; scope.observe(api.state, () => {}); }
  });
  const plugin = s.registry.registration('unrelated', { publicApi: () => ({}), connect(bridge) {
    bridge.watch('counter', () => { pluginAttempts++; throw new Error('plugin connection'); });
  } });
  plugin.activate();
  assert.deepEqual(recovery.failures.getSnapshot(), [{ providerId: 'counter', message: 'workspace connection' }]);
  assert.deepEqual(plugin.failures!.getSnapshot(), [{ providerId: 'counter', message: 'plugin connection' }]);
  assert.equal(s.subscribers(), 1, 'only the healthy connection retains its subscription');
  fail = false; recovery.retryFailed();
  assert.deepEqual(recovery.failures.getSnapshot(), []);
  assert.equal(s.bridge.get('counter'), api, 'the provider is not restarted');
  assert.equal(attempts, 2);
  assert.equal(healthyConnections, 1);
  assert.equal(pluginAttempts, 1, 'workspace retry leaves plugin-owned failures alone');
  assert.equal(s.subscribers(), 2);
  assert.deepEqual(values, [0]);
  s.state.publish(1);
  assert.deepEqual(values, [0, 1]);
  recovery.retryFailed();
  assert.equal(attempts, 2, 'recovered watches do not reconnect');
  s.owner.dispose(); plugin.deactivate(); s.provider.deactivate();
  assert.equal(s.subscribers(), 0);
});

test('late provider failure belongs to each live workspace scope and disappears on unsubscribe or disposal', () => {
  const s = setup(), other = new PluginScope();
  const recovery = s.registry.scopedConnections;
  let attempts = 0;
  const fail = (api: Api | undefined) => { if (api) { attempts++; throw new Error('late connection'); } };
  const stop = s.bridge.watch('counter', fail);
  s.registry.forScope(other).watch('counter', fail);
  assert.deepEqual(recovery.failures.getSnapshot(), []);
  s.provider.activate();
  assert.equal(recovery.failures.getSnapshot().length, 2);
  stop(); stop();
  assert.equal(recovery.failures.getSnapshot().length, 1, 'unsubscribe removes only its own failure');
  recovery.retryFailed();
  assert.equal(attempts, 3);
  other.dispose();
  assert.deepEqual(recovery.failures.getSnapshot(), []);
  recovery.retryFailed(); s.provider.deactivate(); s.provider.activate();
  assert.equal(attempts, 3, 'disposed owners cannot reconnect');
  s.owner.dispose(); s.provider.deactivate();
});

for (const owner of ['workspace', 'plugin']) test(`${owner} failure observers cannot disable a healthy provider or block other consumers`, () => {
  const s = setup();
  let fail = true;
  const connect = (api: Api | undefined) => { if (api && fail) throw new Error('connection'); };
  const plugin = s.registry.registration('unrelated', { publicApi: () => ({}), connect(bridge) {
    if (owner === 'plugin') bridge.watch('counter', connect);
  } });
  plugin.activate();
  if (owner === 'workspace') s.bridge.watch('counter', connect);
  const recovery = owner === 'workspace' ? s.registry.scopedConnections : plugin;
  const stop = recovery.failures!.subscribe(() => { throw new Error('status observer'); });
  const notices: number[] = [];
  const stopNotices = recovery.failures!.subscribe(() => notices.push(recovery.failures!.getSnapshot().length));
  const values: number[] = [];
  s.bridge.watch('counter', (api, scope) => { if (api) scope.observe(api.state, value => values.push(value)); });
  assert.doesNotThrow(s.provider.activate);
  assert.ok(s.bridge.get('counter'));
  assert.ok(s.bridge.get('unrelated'));
  assert.deepEqual(values, [0]);
  assert.deepEqual(notices, [1]);
  assert.equal(s.errors.length, 2, 'both failures are reported without escaping notification');
  stop();
  fail = false; recovery.retryFailed!();
  assert.deepEqual(notices, [1, 0]);
  stopNotices(); s.owner.dispose(); plugin.deactivate(); s.provider.deactivate();
});

test('availability callbacks can disable, replace and unsubscribe without stale delivery', () => {
  const s = setup(), values: string[] = [];
  let replace = true;
  s.bridge.watch('counter', api => {
    values.push(api ? 'first:on' : 'first:off');
    if (api && replace) { replace = false; s.provider.deactivate(); s.provider.activate(); }
  });
  s.bridge.watch('counter', (api, scope) => {
    values.push(api ? 'second:on' : 'second:off');
    if (api) scope.observe(api.state, () => {});
  });
  s.provider.activate();
  assert.deepEqual(values, ['first:off', 'second:off', 'first:on', 'first:on', 'second:on']);
  assert.equal(s.subscribers(), 1);
  s.owner.dispose();
  assert.equal(s.subscribers(), 0);
  assert.deepEqual(s.errors, []);
});

test('a callback can dispose its owner during initial delivery', () => {
  const s = setup(); s.provider.activate();
  s.bridge.watch('counter', (api, scope) => {
    s.owner.dispose();
    scope.observe(api!.state, () => assert.fail('disposed connection cannot receive data'));
  });
  assert.equal(s.subscribers(), 0);
  s.provider.deactivate(); s.provider.activate();
  assert.equal(s.subscribers(), 0);
});

test('listener failures are isolated and events are not replayed', () => {
  const s = setup(), values: number[] = [];
  s.provider.activate();
  s.bridge.watch('counter', () => { throw new Error('connection'); });
  s.bridge.watch('counter', (api, scope) => {
    if (!api) return;
    scope.observe(api.state, value => { if (value !== 0) throw new Error('observer'); });
    scope.listen(api.events, () => { throw new Error('event'); });
  });
  s.events.emit(1);
  s.bridge.watch('counter', (api, scope) => {
    if (!api) return;
    scope.observe(api.state, value => values.push(value));
    scope.listen(api.events, value => values.push(value));
  });
  s.state.publish(2); s.events.emit(3);
  assert.deepEqual(values, [0, 2, 3]);
  assert.equal(s.errors.length, 4);
  s.owner.dispose();
  s.events.emit(4); s.state.publish(5);
  assert.deepEqual(values, [0, 2, 3]);
});

test('unloading aborts queries and rejects a result from a superseded activation', async () => {
  const registry = new PluginRegistry<{ data: { read(): Promise<number> } }>();
  const owner = new PluginScope(), bridge = registry.forScope(owner);
  let finish!: (value: number) => void;
  let signal: AbortSignal | undefined;
  const provider = registry.registration('data', { publicApi(scope) {
    signal = scope.signal;
    return { read: scope.command(() => new Promise<number>(resolve => { finish = resolve; })) };
  } });
  provider.activate();
  const old = bridge.get('data')!, pending = old.read();
  const aborted = assert.rejects(pending, PluginUnavailableError);
  provider.deactivate();
  assert.equal(signal?.aborted, true);
  provider.activate(); finish(7);
  await aborted;
  assert.throws(old.read, PluginUnavailableError);
  provider.deactivate(); owner.dispose();
});

test('selected state shares references and unrelated changes do not wake the consumer', () => {
  const input = createLayerInput<{ route: readonly number[]; title: string }>();
  const route = [1, 2, 3]; input.set({ route, title: 'initial' });
  const registry = new PluginRegistry<{ routes: { plan: LayerStore<readonly number[]> } }>();
  registry.registration('routes', { publicApi: scope => ({ plan: scope.store(selectLayerStore(input, value => value!.route)) }) }).activate();
  const owner = new PluginScope(); let changes = 0;
  registry.forScope(owner).watch('routes', (api, scope) => {
    if (api) scope.observe(api.plan, snapshot => { assert.equal(snapshot, route); changes++; });
  });
  for (let i = 0; i < 1000; i++) input.set({ route, title: String(i) });
  assert.equal(changes, 1);
  owner.dispose();
});

test('partial connection and provider setup failures release acquired resources and allow recovery', () => {
  const s = setup(); s.provider.activate();
  s.bridge.watch('counter', (api, scope) => {
    if (!api) return;
    scope.observe(api.state, () => {});
    throw new Error('partial connection');
  });
  assert.equal(s.subscribers(), 0);
  let released = 0, fail = true;
  const other = s.registry.registration('unrelated', {
    publicApi: () => ({}),
    connect(_bridge, scope) { scope.add(() => released++); if (fail) throw new Error('setup'); },
  });
  assert.throws(other.activate, /setup/);
  assert.equal(s.bridge.get('unrelated'), undefined);
  assert.equal(released, 1);
  fail = false; other.activate();
  assert.ok(s.bridge.get('unrelated'));
  other.deactivate();
  assert.equal(released, 2);
  s.owner.dispose(); s.provider.deactivate();
});

for (const phase of ['snapshot', 'observer']) test(`initial ${phase} failure releases subscriptions and can be retried`, () => {
  const errors: unknown[] = [], values: number[] = [];
  const registry = new PluginRegistry<{ provider: LayerStore<number>; consumer: object }>(error => errors.push(error));
  const state = createLayerStore(42);
  let fail = true, subscribers = 0;
  const provider = registry.registration('provider', { publicApi: scope => scope.store({
    getSnapshot() { if (fail && phase === 'snapshot') throw new Error(phase); return state.getSnapshot(); },
    subscribe(listener) {
      subscribers++;
      const stop = state.subscribe(listener);
      return () => { subscribers--; stop(); };
    },
  }) });
  const consumer = registry.registration('consumer', { publicApi: () => ({}), connect(bridge) {
    bridge.watch('provider', (api, scope) => {
      if (api) scope.observe(api, value => { if (fail) throw new Error(phase); values.push(value); });
    });
  } });
  provider.activate(); consumer.activate();
  assert.deepEqual(consumer.failures!.getSnapshot(), [{ providerId: 'provider', message: phase }]);
  assert.deepEqual(provider.failures!.getSnapshot(), []);
  assert.equal(subscribers, 0);
  assert.deepEqual(values, []);
  fail = false; consumer.retryFailed!();
  assert.deepEqual(consumer.failures!.getSnapshot(), []);
  assert.equal(subscribers, 1);
  assert.deepEqual(values, [42]);
  state.publish(43);
  assert.deepEqual(values, [42, 43]);
  consumer.deactivate(); provider.deactivate();
  assert.equal(subscribers, 0);
  assert.equal(errors.length, 1);
});

test('provider availability changes clear and recover a failed consumer connection', () => {
  const s = setup(); let fail = true, attempts = 0;
  const consumer = s.registry.registration('unrelated', { publicApi: () => ({}), connect(bridge) {
    bridge.watch('counter', (api, scope) => {
      if (!api) return;
      attempts++;
      scope.observe(api.state, () => {});
      if (fail) throw new Error('connection');
    });
  } });
  s.provider.activate(); consumer.activate();
  assert.equal(consumer.failures!.getSnapshot().length, 1);
  assert.equal(s.subscribers(), 0);
  s.provider.deactivate();
  assert.deepEqual(consumer.failures!.getSnapshot(), []);
  fail = false; s.provider.activate();
  assert.deepEqual(consumer.failures!.getSnapshot(), []);
  assert.equal(s.subscribers(), 1);
  consumer.retryFailed!();
  assert.equal(attempts, 2, 'recovered connections are not retried');
  consumer.deactivate(); s.owner.dispose(); s.provider.deactivate();
  assert.equal(s.subscribers(), 0);
});

test('failure cleanup can deactivate its consumer without retaining a stale failure or retry', () => {
  const s = setup(); s.provider.activate();
  let attempts = 0;
  const consumer = s.registry.registration('unrelated', { publicApi: () => ({}), connect(bridge) {
    bridge.watch('counter', (_api, scope) => {
      attempts++;
      scope.add(() => consumer.deactivate());
      throw new Error('setup');
    });
  } });
  consumer.activate();
  assert.equal(s.bridge.get('unrelated'), undefined);
  assert.deepEqual(consumer.failures!.getSnapshot(), []);
  consumer.retryFailed!();
  assert.equal(attempts, 1);
  assert.ok(s.bridge.get('counter'), 'consumer failure leaves the provider available');
  s.owner.dispose(); s.provider.deactivate();
});

test('connection cleanup may replace a provider without delivering its obsolete API', () => {
  const s = setup(); let replace = false;
  const values: number[] = [];
  s.bridge.watch('counter', (api, scope) => {
    if (api) values.push(api.state.getSnapshot());
    scope.add(() => { if (replace) { replace = false; s.provider.deactivate(); s.state.publish(2); s.provider.activate(); } });
  });
  replace = true;
  s.provider.activate();
  assert.deepEqual(values, [2]);
  assert.deepEqual(s.errors, []);
  s.owner.dispose(); s.provider.deactivate();
});

test('combined input subscription failure releases earlier subscriptions and can recover', () => {
  const first = createLayerStore(1), second = createLayerStore(2);
  let subscribers = 0, fail = true;
  const combined = combineLayerStores({ getSnapshot: first.getSnapshot, subscribe(listener) {
    subscribers++;
    const stop = first.subscribe(listener);
    return () => { subscribers--; stop(); };
  } }, { getSnapshot: second.getSnapshot, subscribe(listener) {
    if (fail) throw new Error('second store unavailable');
    return second.subscribe(listener);
  } }, (a, b) => a + b);
  let notifications = 0;
  assert.throws(() => combined.subscribe(() => notifications++), /second store unavailable/);
  assert.equal(subscribers, 0);
  first.publish(3);
  assert.equal(notifications, 0);
  fail = false;
  const stop = combined.subscribe(() => notifications++);
  second.publish(4);
  assert.equal(combined.getSnapshot(), 7);
  assert.equal(notifications, 1);
  stop(); stop();
  assert.equal(subscribers, 0);
});

test('combined input cleanup releases both stores even when one unsubscribe throws', t => {
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (error: unknown) => errors.push(error));
  const listeners = [new Set<() => void>(), new Set<() => void>()];
  const sources = listeners.map((subscribers, index) => ({ getSnapshot: () => 0, subscribe(listener: () => void) {
    subscribers.add(listener);
    return () => { subscribers.delete(listener); if (index === 1) throw new Error('unsubscribe'); };
  } }));
  const combined = combineLayerStores(sources[0]!, sources[1]!, (a, b) => ({ a, b }));
  const snapshot = combined.getSnapshot(), stop = combined.subscribe(() => {});
  assert.doesNotThrow(stop);
  stop();
  assert.ok(listeners.every(subscribers => subscribers.size === 0));
  assert.notEqual(combined.getSnapshot(), snapshot, 'the last subscriber also releases selected state');
  assert.equal(errors.length, 1);
});
