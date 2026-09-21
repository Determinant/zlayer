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
  const calls: { url: string; signal: AbortSignal; finish: () => void }[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = options.signal!;
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    calls.push({ url, signal, finish: () => {
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

test('concurrent consumers of a DEM share one download and decoded cache entry', async t => {
  const { read, calls } = fixture(t);
  const decode = t.mock.method(globalThis, 'createImageBitmap');
  const active = [read(0), read(0), read(0)];
  assert.equal(calls.length, 1, 'coalesce even when network slots are available');
  calls[0]!.finish();
  const results = await Promise.all(active);
  assert.ok(results.every(value => value === results[0]));
  assert.equal(decode.mock.callCount(), 1);
  assert.equal(await read(0), await active[0]);
  assert.equal(calls.length, 1);
});

test('canceling one DEM consumer leaves its peer running; canceling the last aborts and permits retry', async t => {
  const { read, calls } = fixture(t);
  const a = new AbortController(), b = new AbortController();
  const first = assert.rejects(read(0, a.signal), { name: 'AbortError' });
  const second = read(0, b.signal);
  a.abort(); await first;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.signal.aborted, false);
  const canceled = assert.rejects(second, { name: 'AbortError' });
  b.abort(); await canceled;
  assert.equal(calls[0]!.signal.aborted, true);
  const retry = read(0);
  assert.equal(calls.length, 2);
  calls[1]!.finish();
  const value = await retry;
  assert.equal(await read(0), value);
  assert.equal(calls.length, 2, 'the canceled job cannot delete or poison its replacement');
});

test('canceling the initiating DEM reader does not prevent a remaining reader from completing', async t => {
  const { read, calls } = fixture(t);
  const controller = new AbortController();
  const canceled = assert.rejects(read(0, controller.signal), { name: 'AbortError' });
  const remaining = read(0);
  controller.abort(); await canceled;
  calls[0]!.finish();
  const value = await remaining;
  assert.equal(await read(0), value);
  assert.equal(calls.length, 1);
});

test('a late canceled bitmap is closed and cannot displace the replacement DEM job', async t => {
  const { read, calls } = fixture(t);
  const decodes: ((value: ImageBitmap) => void)[] = [];
  t.mock.method(globalThis, 'createImageBitmap', () => new Promise<ImageBitmap>(resolve => { decodes.push(resolve); }));
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  const controller = new AbortController();
  const canceled = assert.rejects(read(0, controller.signal), { name: 'AbortError' });
  calls[0]!.finish(); await turn();
  assert.equal(decodes.length, 1);
  controller.abort(); await canceled;
  const retry = read(0);
  calls[1]!.finish(); await turn();
  let closed = 0;
  const bitmap = () => ({ width: 256, height: 256, close() { closed++; } }) as ImageBitmap;
  decodes[0]!(bitmap()); await turn();
  assert.equal(closed, 1, 'late canceled decoding still releases its bitmap');
  const peer = read(0);
  assert.equal(calls.length, 2, 'late cleanup must not delete the pending replacement');
  decodes[1]!(bitmap());
  assert.equal(await retry, await peer);
  assert.equal(closed, 2);
});

test('decoded DEM cache stays within 128 entries and retains recently used tiles', async t => {
  const { read, calls } = fixture(t);
  const load = async (x: number) => { const result = read(x); calls.at(-1)!.finish(); return result; };
  const first = await load(0);
  for (let x = 1; x < 128; x++) await load(x);
  assert.equal(await read(0), first);
  await load(128);
  assert.equal(await read(0), first);
  assert.equal(calls.length, 129);
  await load(1);
  assert.equal(calls.length, 130, 'the least recently used grid must be decoded again');
});
