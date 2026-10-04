import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { GlideRequest, GlideWorker } from '../src/layers/glide/types';

test('Glide omits only an acknowledged airport plan from the current planner generation', async t => {
  const fixture: { worker?: GlideWorker; revision: number } = { revision: 1 };
  Object.assign(globalThis, { glideTransportFixture: fixture });
  t.after(() => Reflect.deleteProperty(globalThis, 'glideTransportFixture'));
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith('/glide/glide.worker.ts')) return next(specifier, context);
    const code = specifier === 'comlink' ? 'export const expose = api => { globalThis.glideTransportFixture.worker = api; };'
      : specifier === '../terrain/data' ? 'export const createTerrainElevationReader = () => {};'
      : specifier === './planner' ? `export class GlidePlanner { async calculate() { return {
          planRevision: globalThis.glideTransportFixture.revision,
          areas: { type: 'FeatureCollection', features: [] }, airports: [], ownship: null, point: null,
          incomplete: false, work: { planReused: true } }; } }` : undefined;
    return code ? { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(code) } : next(specifier, context);
  } });
  try { await import('../src/layers/glide/glide.worker'); } finally { hook.deregister(); }
  const request: GlideRequest = { id: 1, airports: [], altitude: 6500, ratio: 8, viewport: [], segments: [],
    ownship: null, sources: [], sourceKey: 'first', base: 'https://example.test', tileUrl: '' };
  const worker = fixture.worker!;
  const initial = await worker.calculate(request); assert.ok(initial.plan);
  const pending = await worker.calculate(request); assert.ok(pending.plan, 'unacknowledged geometry is sent again');
  const accepted = await worker.calculate({ ...request, acceptedPlanKey: initial.planKey });
  assert.equal(accepted.plan, undefined); assert.equal(accepted.airportCount, 0);
  fixture.revision++;
  const changed = await worker.calculate({ ...request, acceptedPlanKey: initial.planKey }); assert.ok(changed.plan);
  fixture.revision = 1;
  const replaced = await worker.calculate({ ...request, sourceKey: 'replacement', acceptedPlanKey: initial.planKey });
  assert.ok(replaced.plan); assert.notEqual(replaced.planKey, initial.planKey, 'reused numeric revisions cannot suppress a different planner');
  const recovered = await worker.calculate({ ...request, sourceKey: 'replacement' }); assert.ok(recovered.plan, 'clearing acknowledgement restores full payloads');
});
