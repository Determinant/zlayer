import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';
import type { ComponentProps } from 'react';
import type { CatalogResponse } from '@zlayer/contracts';
import { createLayerInput } from '../src/core/layers/input';
import { createOwnshipLayer } from '../src/layers/ownship/layer';
import { createGpsService } from '../src/core/gps/service';

const input = createLayerInput<{ catalog: CatalogResponse }>();
const state = { input, created: 0, destroyed: 0, catalogs: [] as unknown[], camera: 'initial' };
Object.assign(globalThis, { testMapState: state });
const moduleUrl = (source: string) => 'data:text/javascript,' + encodeURIComponent(source);
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react') return { url: hookModule, shortCircuit: true };
  if (specifier === 'react/jsx-runtime') return { url: moduleUrl(
    'export function jsx(type, props) { if (props.ref) props.ref.current = {}; return props; }'), shortCircuit: true };
  if (specifier === './runtime' && context.parentURL?.includes('/workspace/map/canvas')) return { url: moduleUrl(`
    export class MapRuntime {
      constructor() { const s = globalThis.testMapState; s.created++; s.camera = 'initial';
        const update = () => s.catalogs.push(s.input.require().catalog);
        update(); this.unsubscribe = s.input.subscribe(update); }
      destroy() { this.unsubscribe(); globalThis.testMapState.destroyed++; }
      focus() {} fitRoute() {} setContributions() {}
    }`), shortCircuit: true };
  return next(specifier, context);
} });
const { MapCanvas } = await import('../src/workspace/map/canvas');
loader.deregister();

test('catalog refreshes update an existing map and preserve the user camera', () => {
  const hooks = new Hooks();
  Object.assign(globalThis, { testHooks: hooks });
  const catalog: CatalogResponse = { schemaVersion: 1, revision: '2026-09-03',
    generatedAt: '2026-09-03T00:00:00Z', charts: [], navigation: [], weather: [] };
  input.set({ catalog });
  let props: ComponentProps<typeof MapCanvas> = {
    contributions: [], orientation: createOwnshipLayer(createGpsService()), focusTarget: undefined,
    onViewportChange() {}, onReady() {}, onError(message) { assert.fail(message); },
  };
  const catalogs = [catalog, { ...catalog }, { ...catalog, revision: '2026-10-01' }];
  const render = () => hooks.render(() => MapCanvas(props));
  render();
  state.camera = 'user-panned';
  for (const updated of catalogs.slice(1)) {
    input.set({ catalog: updated });
    props = { ...props };
    render();
  }
  props = { ...props, contributions: [{ id: 'new-plugin', async load() { return []; } }] };
  render();
  props = { ...props, contributions: [] };
  render();
  assert.equal(state.created, 1);
  assert.equal(state.destroyed, 0);
  assert.deepEqual(state.catalogs, catalogs);
  assert.equal(state.camera, 'user-panned');
  hooks.unmount();
  assert.equal(state.destroyed, 1);
});
