import assert from 'node:assert/strict';
import test from 'node:test';
import { requestJson, weatherCheckedAt } from '../src/core/data/request-json';
import { isSourceCollection } from '../src/layers/weather-awc/source';
import { WEATHER_NOW } from './fixtures/awc-advisories';

test('network-only JSON acquisition cancels oversized streams and rejects invalid/empty documents', async t => {
  assert.throws(() => weatherCheckedAt(new Response('', { headers: { 'X-Weather-Checked-At': 'tomorrow' } }), WEATHER_NOW));
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; },
  })));
  await assert.rejects(requestJson('https://test/', isSourceCollection, 'Weather', { maxBytes: 50 }), /response limit/);
  assert.equal(cancelled, true);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ type: 'FeatureCollection', features: {} }));
  await assert.rejects(requestJson('https://test/', isSourceCollection, 'Weather'), /invalid document/);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  await assert.rejects(requestJson('https://test/', isSourceCollection, 'Weather'), /no document/);
});

test('bounded JSON consumption accepts split UTF-8 and cancels a stalled body on abort', async () => {
  const { readJsonResponse } = await import('../src/core/data/request-json');
  const bytes = new TextEncoder().encode(JSON.stringify({ raw: 'café ⛅' }));
  let offset = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) controller.close();
    else controller.enqueue(bytes.subarray(offset, ++offset));
  } }));
  assert.deepEqual(await readJsonResponse(response, 'Reports', bytes.length), { raw: 'café ⛅' });
  const controller = new AbortController();
  let cancelled = false;
  const pending = readJsonResponse(new Response(new ReadableStream({ cancel() { cancelled = true; } })), 'Reports', 64, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejected; assert.ok(cancelled);
});
