import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fetchMagneticModel } from '../src/layers/ahrs/magnetic-data';
import { cacheFixture } from './helpers/cache';

const model = JSON.parse(readFileSync(new URL('./fixtures/magnetic-model.json', import.meta.url), 'utf8'));
const revision = '2026-09-03', generatedAt = '2026-09-18T23:33:42.867Z';
const root = `https://charts.tedyin.com/charts/${revision}/nav`;
const manifestUrl = `${root}/manifest.json`, modelUrl = `${root}/geographic.json?v=${encodeURIComponent(generatedAt)}`;
const manifest = { schemaVersion: 1, effectiveDate: revision, generatedAt,
  products: [{ id: 'magnetic-model', file: 'geographic.json', count: 90 }] };

test('magnetic loader discovers the published filename/version and reuses validated exports offline', async t => {
  const { stored } = cacheFixture(t);
  const requests: string[] = [];
  let offline = false;
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    requests.push(input);
    if (offline) throw new TypeError('offline');
    assert.ok([manifestUrl, modelUrl].includes(input));
    return Response.json(input === manifestUrl ? manifest : model);
  });
  assert.deepEqual(await fetchMagneticModel(revision), model);
  assert.deepEqual(requests, [manifestUrl, modelUrl]);
  assert.ok(stored.has(modelUrl));
  offline = true;
  assert.deepEqual(await fetchMagneticModel(revision), model);
  assert.deepEqual(requests, [manifestUrl, modelUrl, manifestUrl]);
});

test('magnetic loading rejects missing products, mixed cycles, bad conventions and cancellation', async t => {
  const { stored } = cacheFixture(t);
  let responseModel = model, responseManifest = manifest;
  t.mock.method(globalThis, 'fetch', async (input: string) =>
    Response.json(input === manifestUrl ? responseManifest : responseModel));
  responseManifest = { ...manifest, products: [] };
  await assert.rejects(fetchMagneticModel(revision), /missing magnetic-model/);
  responseManifest = manifest;
  responseModel = { ...model, effectiveDate: '2026-08-06' };
  await assert.rejects(fetchMagneticModel(revision), /invalid document/);
  assert.equal(stored.has(modelUrl), false);
  responseModel = { ...model, normalization: 'unknown' };
  await assert.rejects(fetchMagneticModel(revision), /invalid document/);
  assert.equal(stored.has(modelUrl), false);
  await assert.rejects(fetchMagneticModel(revision, AbortSignal.abort()), { name: 'AbortError' });
  await assert.rejects(fetchMagneticModel('../outside-feed'), /Unsupported FAA cycle/);
});
