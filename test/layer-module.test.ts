import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MapLayerHost, type MapLayerModule, type LayerSlot } from '../src/core/map/layer';

const map = { getLayer: (id: string) => id === 'present' ? {} : undefined } as unknown as MapLibreMap;
test('mounts products by slot, updates without remounting, and cleans up in reverse order', () => {
  const events: string[] = [];
  const module = (id: string, slot: LayerSlot): MapLayerModule<number> => ({
    id, slot, interactiveLayerIds: ['present', 'missing'],
    mount: () => { events.push(`mount:${id}`); },
    update: value => { events.push(`update:${id}:${value}`); },
    unmount: () => { events.push(`unmount:${id}`); },
  });
  const weather = module('metar', 'weather');
  const charts = module('ifr-low', 'charts');
  const host = new MapLayerHost(map, (_id, error) => { throw error; });
  host.mount([weather, charts]);
  host.update(weather, 2);
  assert.deepEqual(events, ['mount:ifr-low', 'mount:metar', 'update:metar:2']);
  assert.deepEqual(host.interactiveLayerIds(), ['present', 'present']);
  host.unmount();
  host.unmount();
  assert.deepEqual(host.interactiveLayerIds(), []);
  assert.deepEqual(events.slice(3), ['unmount:metar', 'unmount:ifr-low']);
});

test('isolates partial mount/update failures, including a failing cleanup', () => {
  const errors: string[] = [];
  let mounted = 0;
  let updates = 0;
  const bad: MapLayerModule<void> = {
    id: 'bad', slot: 'charts',
    mount() { throw new Error('mount'); }, update() { throw new Error('must not update'); },
    unmount() { throw new Error('cleanup'); },
  };
  const good: MapLayerModule<void> = {
    id: 'good', slot: 'weather', mount() { mounted++; },
    update() { updates++; }, unmount() {},
  };
  const host = new MapLayerHost(map, (id, error) => errors.push(`${id}:${(error as Error).message}`));
  host.mount([bad, good]);
  host.update(bad, undefined);
  host.update(good, undefined);
  assert.equal(mounted, 1);
  assert.equal(updates, 1);
  assert.deepEqual(errors, ['bad:cleanup', 'bad:mount']);
  good.update = () => { throw new Error('update'); };
  host.update(good, undefined);
  assert.equal(errors.at(-1), 'good:update');
  host.unmount();
  host.mount([good]);
  assert.equal(mounted, 2, 'a new map attachment retries failed modules');
  assert.throws(() => host.mount([good, good]), /Duplicate layer/);
});


test('reconciliation keeps healthy attachments alive and preserves order across late additions and removals', () => {
  const order: string[] = [], events: string[] = [];
  const map = {
    getLayer: (id: string) => order.includes(id),
    addLayer: ({ id }: { id: string }) => { order.push(id); },
    removeLayer: (id: string) => { order.splice(order.indexOf(id), 1); },
    moveLayer: (id: string, before?: string) => {
      order.splice(order.indexOf(id), 1);
      order.splice(before ? order.indexOf(before) : order.length, 0, id);
    },
  } as unknown as MapLibreMap;
  const module = (id: string, slot: LayerSlot): MapLayerModule<void> => ({
    id, slot, overlayLayerIds: [`${id}-point`], foregroundLayerIds: [`${id}-label`],
    focusedLayerIds: slot === 'ownship' ? [] : [`${id}-focused`],
    mount() { events.push(`mount:${id}`); order.push(`${id}-point`, `${id}-label`, ...(this.focusedLayerIds ?? [])); }, update() {},
    unmount() {
      events.push(`unmount:${id}`);
      for (const id of this.focusedLayerIds ?? []) map.removeLayer(id);
      map.removeLayer(`${id}-label`); map.removeLayer(`${id}-point`);
    },
  });
  const route = module('route', 'route'), navigation = module('navigation', 'navigation'), ownship = module('gps', 'ownship');
  const host = new MapLayerHost(map, (_id, error) => { throw error; });
  host.reconcile([ownship, route]);
  host.reconcile([ownship, navigation, route]);
  assert.deepEqual(events, ['mount:route', 'mount:gps', 'mount:navigation']);
  assert.deepEqual(order.filter(id => !id.startsWith('zlayer-')), [
    'navigation-point', 'route-point', 'gps-point', 'navigation-label', 'route-label', 'navigation-focused', 'route-focused', 'gps-label',
  ]);
  host.reconcile([ownship, route]);
  assert.deepEqual(events, ['mount:route', 'mount:gps', 'mount:navigation', 'unmount:navigation']);
  assert.deepEqual(order.filter(id => !id.startsWith('zlayer-')), ['route-point', 'gps-point', 'route-label', 'route-focused', 'gps-label']);
  host.reconcile([route, navigation, ownship]);
  assert.deepEqual(order.filter(id => !id.startsWith('zlayer-')).slice(-3), ['navigation-focused', 'route-focused', 'gps-label']);
  host.unmount();
  assert.deepEqual(order, []);
});

test('reconciliation does not retry a failed adapter until it has been unloaded', () => {
  let mounts = 0, unmounts = 0;
  const bad: MapLayerModule<void> = { id: 'bad', slot: 'route',
    mount() { mounts++; throw new Error('mount'); }, update() {}, unmount() { unmounts++; } };
  const good: MapLayerModule<void> = { id: 'good', slot: 'navigation', mount() {}, update() {}, unmount() {} };
  const host = new MapLayerHost(map, () => {});
  host.reconcile([bad]);
  host.reconcile([good, bad]);
  assert.equal(mounts, 1);
  assert.equal(unmounts, 1);
  host.reconcile([good]);
  host.reconcile([good, bad]);
  assert.equal(mounts, 2);
  assert.equal(unmounts, 2);
  host.unmount();
});
