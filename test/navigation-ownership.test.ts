import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { CatalogResponse, FeatureCollectionResponse } from '@zlayer/contracts';
import { fetchNavigationResult, type NavigationResult } from '../src/layers/navigation/api';

// Test actual ephemeron ownership, not a mock that discards still-live objects.
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;
async function collectAcrossTasks() {
  for (let i = 0; i < 10; i++) { await tick(); collect(); }
}

test('regional navigation shares a live collection and releases the whole graph when its owners leave', async t => {
  const catalog: CatalogResponse = { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-16T00:00:00Z',
    charts: [], weather: [], navigation: [{ id: 'airports', title: 'Airports',
      url: 'https://charts.test/ownership/airports', count: 1, sourceCount: 1, minZoom: 0 }] };
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    reads++;
    return Response.json({ type: 'FeatureCollection', metadata: { effectiveDate: catalog.revision, source: 'FAA' },
      features: [{ type: 'Feature', id: 'KSBA', properties: { ident: 'KSBA', name: 'Santa Barbara' },
        geometry: { type: 'Point', coordinates: [-119.84, 34.43] } }] });
  });
  let wrapper: WeakRef<NavigationResult>, sourceFeature: WeakRef<object>;
  const read = () => fetchNavigationResult(catalog.navigation[0]!, catalog.revision, [], catalog);
  let collection: FeatureCollectionResponse | undefined = await read().then(result => {
    wrapper = new WeakRef(result);
    sourceFeature = new WeakRef(result.collection!.features[0]!.geometry);
    return result.collection;
  });
  assert.ok(collection);
  const weakCollection = new WeakRef(collection);
  await collectAcrossTasks();
  assert.ok(wrapper!.deref(), 'the collection keeps its cache identity alive');
  await read().then(result => assert.equal(result.collection, collection, 'a live map and a new reader share one composition'));
  assert.equal(reads, 1);
  collection = undefined;
  await collectAcrossTasks();
  assert.equal(wrapper!.deref(), undefined);
  assert.equal(weakCollection.deref(), undefined);
  assert.equal(sourceFeature!.deref(), undefined, 'source ownership must not turn the weak cycle into a leak');
  assert.ok((await read()).collection);
  assert.equal(reads, 2, 'unused source data can be collected and loaded again');
});
