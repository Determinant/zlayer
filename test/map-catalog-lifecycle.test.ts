import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';
import type { ComponentProps } from 'react';
import type { CatalogResponse } from '@zlayer/contracts';
import { emptyRoutePlan } from '@zlayer/domain';
import { MetarClient } from '../src/layers/metar-taf/metar/client';
import { createMetarLayer } from '../src/layers/metar-taf/metar/layer';
import { DEFAULT_VISIBILITY } from '../src/layers/navigation/definitions';
import { DEFAULT_FIX_DISPLAY } from '../src/layers/navigation/fix-display';
import { createOwnshipLayer } from '../src/layers/ownship/layer';

const state = { created: 0, destroyed: 0, catalogs: [] as unknown[], camera: 'initial' };
Object.assign(globalThis, { testMapState: state });
const moduleUrl = (source: string) => 'data:text/javascript,' + encodeURIComponent(source);
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react') return { url: hookModule, shortCircuit: true };
  if (specifier === 'react/jsx-runtime') return { url: moduleUrl(
    'export function jsx(type, props) { if (props.ref) props.ref.current = {}; return props; }'), shortCircuit: true };
  if (specifier === './runtime' && context.parentURL?.includes('/workspace/map/canvas')) return { url: moduleUrl(`
    export class MapRuntime {
      constructor() { globalThis.testMapState.created++; globalThis.testMapState.camera = 'initial'; }
      update(value) { globalThis.testMapState.catalogs.push(value.catalog); }
      destroy() { globalThis.testMapState.destroyed++; }
      focus() {} fitRoute() {}
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
  let props: ComponentProps<typeof MapCanvas> = {
    catalog, chartSelection: { base: '', overlay: '' }, visibility: DEFAULT_VISIBILITY,
    fixContext: { fixDisplay: DEFAULT_FIX_DISPLAY, airways: undefined, priorityFixes: [] },
    data: {}, route: emptyRoutePlan(''), recommendations: undefined,
    metarLayer: createMetarLayer(new MetarClient(new URL('https://app.test/weather'))),
    ownshipLayer: createOwnshipLayer(), ownshipEnabled: false, metarEnabled: false,
    terrainEnabled: false, obstructionsEnabled: false, terrainAltitude: null, routeFocusNonce: 0, focusTarget: undefined,
    onSelect() {}, onViewportChange() {}, onRouteLegInsert() {}, onRouteWaypointReplace() {},
    onRouteWaypointRemove() {}, onReady() {}, onTerrainStatus() {}, onObstructionStatus() {},
    onError(message) { assert.fail(message); },
  };
  const catalogs = [catalog, { ...catalog }, { ...catalog, revision: '2026-10-01' }];
  const render = () => hooks.render(() => MapCanvas(props));
  render();
  state.camera = 'user-panned';
  for (const updated of catalogs.slice(1)) {
    props = { ...props, catalog: updated };
    render();
  }
  assert.equal(state.created, 1);
  assert.equal(state.destroyed, 0);
  assert.deepEqual(state.catalogs, catalogs);
  assert.equal(state.camera, 'user-panned');
  hooks.unmount();
  assert.equal(state.destroyed, 1);
});
