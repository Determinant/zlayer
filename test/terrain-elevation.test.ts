import assert from 'node:assert/strict';
import test from 'node:test';
import { ElevationTiles } from '../src/layers/terrain/elevation';

function fixture(t: test.TestContext) {
  const pixels = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 128; pixels[i + 3] = 255; }
  const originals = ['OffscreenCanvas', 'createImageBitmap'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    OffscreenCanvas: class { getContext() { return { canvas: this, drawImage() {}, getImageData: () => ({ data: pixels }) }; } },
    createImageBitmap: async () => ({ width: 256, height: 256, close() {} }),
  });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const calls: { url: string; finish: () => void }[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = options.signal!;
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    calls.push({ url, finish: () => {
      signal.removeEventListener('abort', abort);
      resolve(new Response(new Blob()));
    } });
  }));
  const tiles = new ElevationTiles();
  const read = (x: number, signal = new AbortController().signal) => tiles.read({ z: 9, x, y: 0 }, 'https://terrain.test/{z}/{x}/{y}', signal);
  return { read, calls };
}

test('DEM downloads stay limited to four and canceled queued reads finish without waiting for the network', { timeout: 3000 }, async t => {
  const { read, calls } = fixture(t);
  const active = [0, 1, 2, 3].map(x => read(x));
  const controller = new AbortController();
  const canceled = assert.rejects(read(4, controller.signal), { name: 'AbortError' });
  const next = read(5);
  assert.equal(calls.length, 4);
  controller.abort();
  await canceled;
  assert.equal(calls.length, 4, 'canceling a queued read does not steal an occupied network slot');
  calls[0]!.finish();
  await active[0];
  assert.equal(calls.length, 5);
  assert.ok(calls[4]!.url.endsWith('/5/0'), 'the next live request skips the canceled queue entry');
  for (const call of calls.slice(1)) call.finish();
  await Promise.all([...active, next]);
});

test('a tile populated while queued reuses its decoded cache entry', async t => {
  const { read, calls } = fixture(t);
  const active = [0, 1, 2, 3].map(x => read(x));
  const queued = read(0);
  calls[0]!.finish();
  assert.equal(await queued, await active[0]);
  assert.equal(calls.length, 4, 'waiting for a slot must not refetch a tile that became cached');
  assert.equal(await read(0), await active[0]);
  for (const call of calls.slice(1)) call.finish();
  await Promise.all(active);
});
