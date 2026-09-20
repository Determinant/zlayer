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
