import { performance } from 'node:perf_hooks';
import { PluginRegistry, PluginScope } from '../src/core/layers/bridge';
import { createLayerStore, type LayerStore } from '../src/core/layers/store';

// A repeatable local comparison, not a timing assertion or device certification.
const iterations = 500_000;
function sample(run: () => void): number {
  run();
  const samples: number[] = [];
  for (let i = 0; i < 7; i++) { const start = performance.now(); run(); samples.push(performance.now() - start); }
  return samples.sort((a, b) => a - b)[3]! * 1e6 / iterations;
}
let observed = 0;
const direct = createLayerStore(0), bridged = createLayerStore(0);
for (let i = 0; i < 3; i++) direct.subscribe(() => { observed = direct.getSnapshot(); });
const registry = new PluginRegistry<{ routes: { plan: LayerStore<number> } }>();
const provider = registry.registration('routes', { publicApi: scope => ({ plan: scope.store(bridged) }) });
provider.activate();
const owners = Array.from({ length: 3 }, () => new PluginScope());
for (const owner of owners) registry.forScope(owner).watch('routes', (api, scope) => {
  if (api) scope.observe(api.plan, value => { observed = value; });
});
const baseline = sample(() => { for (let i = 0; i < iterations; i++) direct.publish(i); });
const connected = sample(() => { for (let i = 0; i < iterations; i++) bridged.publish(i); });
const bridge = registry.forScope(owners[0]!);
const lookup = sample(() => { for (let i = 0; i < iterations; i++) observed = bridge.get('routes')!.plan.getSnapshot(); });
console.log(JSON.stringify({ iterations, consumers: 3, medianNanoseconds: {
  directPublish: Math.round(baseline), bridgedPublish: Math.round(connected),
  addedPerPublish: Math.round(connected - baseline), lookupAndRead: Math.round(lookup),
}, observed }, null, 2));
for (const owner of owners) owner.dispose();
provider.deactivate();
