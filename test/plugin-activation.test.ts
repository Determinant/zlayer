import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';
import type { LayerPlugin } from '../src/core/layers/plugin';
import { PluginRegistry, type PluginScope } from '../src/core/layers/bridge';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { usePlugins } = await import('../src/core/layers/use-plugins');
loader.deregister();

function activationHarness(t: test.TestContext, initial: readonly LayerPlugin[]) {
  const saved = new Map<string, string>();
  const hooks = new Hooks();
  const globals = ['window', 'testHooks'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, { window: { localStorage: {
    getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value),
  } }, testHooks: hooks });
  let plugins = initial;
  t.after(() => {
    hooks.unmount();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const render = () => hooks.render(() => usePlugins(plugins));
  return { saved, render, settle: () => { render(); return render(); }, replace: (next: readonly LayerPlugin[]) => { plugins = next; } };
}

test('real bridge failures degrade only their consumer and retry only its failed watches', t => {
  const errors: unknown[] = [], scopes: PluginScope[] = [];
  const registry = new PluginRegistry<{ provider: object; consumer: object; unrelated: object }>(error => errors.push(error));
  let fail = true, providerStarts = 0, consumerStarts = 0, healthyConnections = 0, unrelatedAttempts = 0;
  const provider = { definition: { id: 'provider', title: 'Provider' },
    communication: registry.registration('provider', { publicApi() { providerStarts++; return {}; } }),
  };
  const consumer = { definition: { id: 'consumer', title: 'Consumer' },
    communication: registry.registration('consumer', {
      publicApi() { consumerStarts++; return {}; },
      connect(bridge) {
        bridge.watch('provider', (_api, scope) => { scopes.push(scope); if (fail) throw new Error('integration failed'); });
        bridge.watch('provider', () => { healthyConnections++; });
      },
    }),
    controls: [{ id: 'consumer', Component: () => null }],
    mapContribution: { id: 'consumer', async load() { return []; } },
  };
  const unrelated = { definition: { id: 'unrelated', title: 'Unrelated' },
    communication: registry.registration('unrelated', { publicApi: () => ({}), connect(bridge) {
      bridge.watch('provider', () => { unrelatedAttempts++; throw new Error('unrelated failure'); });
    } }),
  };
  const child = { definition: { id: 'child', title: 'Child' }, requires: ['consumer'] };
  const { saved, render, settle } = activationHarness(t, [provider, consumer, unrelated, child]);
  let state = settle();
  assert.deepEqual(state.controlsList.map(plugin => plugin.status), ['ready', 'degraded', 'degraded', 'ready']);
  assert.ok(state.controlsList.every(plugin => plugin.loaded && plugin.enabled));
  assert.match(state.controlsList[1]!.error!, /provider: integration failed/);
  assert.deepEqual(state.controls.map(control => control.id), ['consumer']);
  assert.deepEqual(state.mapContributions.map(contribution => contribution.id), ['consumer']);
  assert.equal(scopes[0]!.signal.aborted, true, 'partial connection work is released');
  assert.equal(saved.size, 0, 'connection failures do not change saved intent');
  render(); render();
  assert.equal(scopes.length, 1, 'ordinary renders do not retry failed watches');
  fail = false;
  state.setLoaded('consumer', true); state = settle();
  assert.equal(state.controlsList[1]!.status, 'ready');
  assert.equal(state.controlsList[1]!.error, undefined);
  assert.equal(scopes.length, 2);
  assert.equal(scopes[1]!.signal.aborted, false);
  assert.equal(providerStarts, 1);
  assert.equal(consumerStarts, 1, 'retry does not restart the consumer feature');
  assert.equal(healthyConnections, 1, 'healthy watches for the same provider stay connected');
  assert.equal(unrelatedAttempts, 1);
  assert.equal(state.controlsList[2]!.status, 'degraded');
  assert.equal(errors.length, 2);
});

test('a provider enabled later reports failure to its consumer and disabling clears its retry state', t => {
  const registry = new PluginRegistry<{ provider: object; consumer: object }>(() => {});
  let fail = true, attempts = 0, providerStarts = 0;
  const consumer = { definition: { id: 'consumer', title: 'Consumer' },
    communication: registry.registration('consumer', { publicApi: () => ({}), connect(bridge) {
      bridge.watch('provider', api => { if (api) { attempts++; if (fail) throw new Error('late connection'); } });
    } }),
  };
  const provider = { definition: { id: 'provider', title: 'Provider' },
    communication: registry.registration('provider', { publicApi() { providerStarts++; return {}; } }),
  };
  const { saved, settle } = activationHarness(t, [consumer, provider]);
  saved.set('zlayer-ui:plugins-unloaded', JSON.stringify({ version: 1, value: ['provider'] }));
  let state = settle();
  assert.equal(state.controlsList[0]!.status, 'ready');
  state.setLoaded('provider', true); state = settle();
  assert.equal(state.controlsList[0]!.status, 'degraded');
  assert.match(state.controlsList[0]!.error!, /provider: late connection/);
  assert.equal(state.controlsList[1]!.status, 'ready');
  state.setLoaded('consumer', true); state = settle();
  assert.equal(state.controlsList[0]!.status, 'degraded', 'another failed retry remains actionable');
  assert.equal(attempts, 2);
  state.setLoaded('consumer', false); state = settle();
  assert.equal(state.controlsList[0]!.status, 'disabled');
  assert.equal(state.controlsList[0]!.error, undefined);
  assert.deepEqual(consumer.communication.failures!.getSnapshot(), []);
  consumer.communication.retryFailed!();
  assert.equal(attempts, 2, 'disposed watches cannot be retried');
  fail = false;
  state.setLoaded('consumer', true); state = settle();
  assert.equal(state.controlsList[0]!.status, 'ready');
  assert.equal(attempts, 3);
  assert.equal(providerStarts, 1);
});

test('failed activation cleans partial work, blocks dependents and retries without restarting healthy plugins', t => {
  const events: string[] = [];
  let fail = true;
  const plugins = ['child', 'provider', 'healthy', 'unrelated'].map(id => ({ definition: { id, title: id },
    ...(id === 'child' ? { requires: ['provider'] } : {}),
    communication: {
      activate() { events.push(`${id}:start`); if (id === 'provider' && fail || id === 'unrelated') throw new Error(`${id} failed`); },
      deactivate() { events.push(`${id}:stop`); },
    },
    dispose() { events.push(`${id}:dispose`); },
    controls: [{ id, Component: () => null }],
    mapContribution: { id, async load() { return []; } },
  }));
  const { saved, render, settle } = activationHarness(t, plugins);
  assert.deepEqual(render().controls, [], 'no contributions attach before successful activation');
  let state = render();
  assert.deepEqual(state.controls.map(control => control.id), ['healthy']);
  assert.deepEqual(state.mapContributions.map(contribution => contribution.id), ['healthy']);
  assert.equal(state.isLoaded('provider'), false);
  assert.equal(state.isLoaded('unknown'), false);
  assert.equal(state.controlsList.find(plugin => plugin.id === 'provider')?.enabled, true);
  assert.equal(state.controlsList.find(plugin => plugin.id === 'provider')?.status, 'failed');
  assert.equal(state.controlsList.find(plugin => plugin.id === 'child')?.status, 'blocked');
  assert.equal(events.includes('child:start'), false, 'required consumers cannot start without their provider');
  assert.equal(saved.size, 0, 'failures do not overwrite saved intent');
  assert.deepEqual(events.slice(0, 3), ['provider:start', 'provider:stop', 'provider:dispose']);
  render(); render();
  assert.equal(events.filter(event => event === 'provider:start').length, 1, 'ordinary renders do not retry');
  state.setLoaded('healthy', false); state = settle();
  state.setLoaded('healthy', true); state = settle();
  assert.equal(events.filter(event => event === 'provider:start').length, 1, 'unrelated toggles do not retry failures');
  const healthyStarts = events.filter(event => event === 'healthy:start').length;
  fail = false;
  state.setLoaded('child', true); state = settle();
  assert.deepEqual(state.controls.map(control => control.id), ['child', 'provider', 'healthy']);
  assert.equal(state.controlsList.find(plugin => plugin.id === 'provider')?.error, undefined);
  assert.equal(state.controlsList.find(plugin => plugin.id === 'unrelated')?.status, 'failed');
  assert.equal(events.filter(event => event === 'unrelated:start').length, 1, 'retry is limited to the requested dependency chain');
  assert.equal(events.filter(event => event === 'healthy:start').length, healthyStarts);
  assert.deepEqual(events.slice(-2), ['provider:start', 'child:start']);
});

test('disabling a failed plugin clears the failure without double disposal and re-enable can retry', t => {
  let starts = 0, disposals = 0;
  const plugin = { definition: { id: 'failed', title: 'Failed' },
    communication: { activate() { starts++; throw new Error('offline'); }, deactivate() {} },
    dispose() { disposals++; },
  };
  const { settle, saved } = activationHarness(t, [plugin]);
  let state = settle();
  assert.equal(disposals, 1);
  state.setLoaded('failed', false); state = settle();
  assert.equal(state.controlsList[0]?.status, 'disabled');
  assert.equal(state.controlsList[0]?.error, undefined);
  assert.equal(disposals, 1);
  assert.deepEqual(JSON.parse(saved.get('zlayer-ui:plugins-unloaded')!).value, ['failed']);
  state.setLoaded('failed', true); state = settle();
  assert.equal(starts, 2);
  assert.equal(disposals, 2);
  assert.equal(state.controlsList[0]?.status, 'failed');
});

test('replacing a prerequisite detaches its consumers before activating the replacement', t => {
  const events: string[] = [];
  const provider = (name: string) => ({ definition: { id: 'provider', title: name },
    communication: { activate() { events.push(`${name}:start`); }, deactivate() { events.push(`${name}:stop`); } },
  });
  const child = { definition: { id: 'child', title: 'Child' }, requires: ['provider'],
    communication: { activate() { events.push('child:start'); }, deactivate() { events.push('child:stop'); } },
    controls: [{ id: 'child', Component: () => null }],
  };
  const { render, settle, replace } = activationHarness(t, [child, provider('old')]);
  settle(); events.length = 0;
  replace([child, provider('new')]);
  assert.deepEqual(render().controls, [], 'dependent UI is removed while the new provider is pending');
  assert.deepEqual(events, ['child:stop', 'old:stop', 'new:start', 'child:start']);
  assert.equal(render().isLoaded('child'), true);
});

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
  state.setLoaded('ahrs', true); render(); state = render();
  assert.deepEqual(state.controls.map(control => control.id), ['ahrs', 'gps', 'charts']);
  state.setLoaded('charts', false); render();
  hooks.unmount();
  assert.deepEqual(events, ['ahrs', 'gps', 'charts', 'ahrs', 'gps']);
  const restart = new Hooks(); Object.assign(globalThis, { testHooks: restart });
  restart.render(() => usePlugins(plugins));
  const restored = restart.render(() => usePlugins(plugins));
  assert.equal(restored.isLoaded('charts'), false);
  assert.equal(restored.isLoaded('ahrs'), true);
  restart.unmount();
  Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'testHooks');
});

test('communication activates once, revokes before feature disposal and reconnects on re-enable', () => {
  const saved = new Map<string, string>([['zlayer-ui:plugins-unloaded', JSON.stringify({ version: 1, value: ['optional'] })]]);
  Object.assign(globalThis, { window: { localStorage: {
    getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value),
  } } });
  const events: string[] = [];
  const plugins = ['provider', 'optional'].map(id => ({ definition: { id, title: id },
    communication: { activate() { events.push(`${id}:connect`); }, deactivate() { events.push(`${id}:disconnect`); } },
    dispose() { events.push(`${id}:dispose`); },
  }));
  const hooks = new Hooks(); Object.assign(globalThis, { testHooks: hooks });
  const render = () => hooks.render(() => usePlugins(plugins));
  let state = render(); render();
  assert.deepEqual(events, ['provider:connect']);
  state.setLoaded('optional', true); state = render();
  state.setLoaded('provider', false); state = render();
  assert.deepEqual(events, ['provider:connect', 'optional:connect', 'provider:disconnect', 'provider:dispose']);
  state.setLoaded('provider', true); render();
  hooks.unmount();
  assert.deepEqual(events.slice(4), ['provider:connect', 'optional:disconnect', 'optional:dispose', 'provider:disconnect', 'provider:dispose']);
  Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'testHooks');
});

test('communication cleanup failure cannot skip feature disposal on disable or workspace teardown', t => {
  const saved = new Map<string, string>();
  Object.assign(globalThis, { window: { localStorage: {
    getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value),
  } } });
  t.after(() => { Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'testHooks'); });
  const events: string[] = [], errors: unknown[] = [];
  t.mock.method(console, 'error', (error: unknown) => errors.push(error));
  const plugins = ['healthy', 'broken'].map(id => ({ definition: { id, title: id },
    communication: { activate() {}, deactivate() {
      events.push(`${id}:disconnect`);
      if (id === 'broken') throw new Error('connection cleanup');
    } },
    dispose() { events.push(`${id}:dispose`); },
  }));
  const hooks = new Hooks(); Object.assign(globalThis, { testHooks: hooks });
  const render = () => hooks.render(() => usePlugins(plugins));
  let state = render();
  state.setLoaded('broken', false); state = render();
  assert.deepEqual(events, ['broken:disconnect', 'broken:dispose']);
  assert.match(render().error!, /connection cleanup/);
  state.setLoaded('broken', true); render();
  hooks.unmount();
  assert.deepEqual(events.slice(2), ['broken:disconnect', 'broken:dispose', 'healthy:disconnect', 'healthy:dispose']);
  assert.equal(errors.length, 1);
});
