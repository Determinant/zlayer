import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { createMbtilesReader } from '../src/layers/charts/mbtiles-reader.js';

function archive(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE tiles (
    zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
    PRIMARY KEY (zoom_level, tile_column, tile_row)
  )`);
  const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
  return {
    add: (z: number, x: number, tmsY: number, value: number) =>
      insert.run(z, x, tmsY, new Uint8Array([value])),
    query: async (sql: string, parameters: number[]) => db.prepare(sql).all(...parameters),
  };
}

test('uses stored low-zoom tiles regardless of manifest display cutoffs', async (t) => {
  const source = archive(t);
  source.add(5, 5, 3, 42);
  source.add(7, 20, 12, 70);
  const read = await createMbtilesReader(source.query, async () => {
    throw new Error('An existing tile must not be recomposed');
  });
  assert.deepEqual(
    new Uint8Array(await read({ z: 5, x: 5, y: 28 }, new AbortController().signal) as ArrayBuffer),
    new Uint8Array([42]),
  );
});

test('underzooms a sparse archive with correct TMS orientation and clipping', async (t) => {
  const source = archive(t);
  source.add(7, 20, 15, 1); // northwest
  source.add(7, 23, 15, 2); // northeast
  source.add(7, 20, 12, 3); // southwest
  source.add(7, 23, 12, 4); // southeast
  source.add(7, 24, 15, 5); // outside the requested parent
  source.add(8, 40, 30, 6); // finer tile: not needed for an overview
  const overview = {} as ImageBitmap;
  const read = await createMbtilesReader(source.query, async (parts) => {
    assert.deepEqual(parts.map((part) => ({
      value: new Uint8Array(part.data)[0], x: part.x, y: part.y, size: part.size,
    })).sort((a, b) => a.value! - b.value!), [
      { value: 1, x: 0, y: 0, size: 64 },
      { value: 2, x: 192, y: 0, size: 64 },
      { value: 3, x: 0, y: 192, size: 64 },
      { value: 4, x: 192, y: 192, size: 64 },
    ]);
    return overview;
  });
  assert.equal(await read({ z: 5, x: 5, y: 28 }, new AbortController().signal), overview);
  assert.equal(await read({ z: 5, x: 4, y: 28 }, new AbortController().signal), null);
  // An absent tile at a native zoom remains a transparent cutline hole.
  assert.equal(await read({ z: 8, x: 41, y: 225 }, new AbortController().signal), null);
});

test('stops an obsolete tile read before querying or rendering', async (t) => {
  const source = archive(t);
  source.add(7, 20, 15, 1);
  const controller = new AbortController();
  let queries = 0;
  const read = await createMbtilesReader(async (sql, parameters) => {
    queries += 1;
    return source.query(sql, parameters);
  }, async () => { throw new Error('Cancelled overview must not render'); });
  controller.abort();
  await assert.rejects(read({ z: 5, x: 5, y: 28 }, controller.signal), { name: 'AbortError' });
  assert.equal(queries, 1); // archive metadata only

  const duringRead = new AbortController();
  const readThenAbort = await createMbtilesReader(async (sql, parameters) => {
    const result = await source.query(sql, parameters);
    if (parameters.length) duringRead.abort();
    return result;
  }, async () => { throw new Error('Cancelled overview must not render'); });
  await assert.rejects(readThenAbort({ z: 5, x: 5, y: 28 }, duringRead.signal), {
    name: 'AbortError',
  });
});

test('overzooms all quadrants from the actual maximum with correct TMS orientation', async (t) => {
  const source = archive(t);
  source.add(4, 3, 10, 4);
  source.add(11, 440, 1344, 42);
  let expectedX = 0;
  let expectedY = 0;
  let expectedScale = 2;
  const overview = {} as ImageBitmap;
  const queries: number[][] = [];
  const read = await createMbtilesReader(async (sql, parameters) => {
    queries.push(parameters);
    return source.query(sql, parameters);
  }, async (parts) => {
    assert.deepEqual(parts.map(part => ({
      value: new Uint8Array(part.data)[0], x: part.x, y: part.y, size: part.size,
    })), [{ value: 42, x: -expectedX * 256, y: -expectedY * 256, size: expectedScale * 256 }]);
    return overview;
  });
  // L13 stores levels 4–11, although its old manifest advertises a maximum of 12.
  for (const zoom of [12, 13]) {
    expectedScale = 2 ** (zoom - 11);
    for (expectedY = 0; expectedY < expectedScale; expectedY += 1) {
      for (expectedX = 0; expectedX < expectedScale; expectedX += 1) {
        assert.equal(await read({
          z: zoom,
          x: 440 * expectedScale + expectedX,
          y: (2 ** 11 - 1 - 1344) * expectedScale + expectedY,
        }, new AbortController().signal), overview);
        assert.deepEqual(queries.at(-1), [11, 440, 1344]);
      }
    }
  }
  // Do not fill a missing parent from coarser coverage, or a hole at a native zoom.
  assert.equal(await read({ z: 12, x: 882, y: 1406 }, new AbortController().signal), null);
  assert.equal(await read({ z: 10, x: 220, y: 351 }, new AbortController().signal), null);
});

test('rejects empty archives', async (t) => {
  await assert.rejects(createMbtilesReader(archive(t).query), /no valid tile zoom level/);
});

test('returns only the requested byte slice', async () => {
  const bytes = new Uint8Array([0, 12, 34, 0]);
  const read = await createMbtilesReader(async (_sql, parameters) => parameters.length
    ? [{ data: bytes.subarray(1, 3) }]
    : [{ minZoom: 5, maxZoom: 5 }]);
  assert.deepEqual(
    new Uint8Array(await read({ z: 5, x: 5, y: 28 }, new AbortController().signal) as ArrayBuffer),
    new Uint8Array([12, 34]),
  );
});

test('overview rendering releases each bitmap on success, cancellation, or draw failure', async (t) => {
  const source = archive(t);
  source.add(7, 20, 15, 42);
  source.add(7, 21, 15, 43);
  const read = await createMbtilesReader(source.query);
  const events: string[] = [];
  const canvases: { width: number; height: number }[] = [];
  let controller = new AbortController();
  let mode: 'success' | 'cancel' | 'draw-failure' | 'snapshot-cancel' | 'snapshot-failure' = 'success';
  const overview = { close: () => events.push('close-overview') } as unknown as ImageBitmap;
  const context = {
    imageSmoothingQuality: 'low',
    drawImage() {
      events.push('draw');
      if (mode === 'draw-failure') throw new Error('draw failed');
    },
  };
  const browserStubs = {
    OffscreenCanvas: class {
      constructor(public width: number, public height: number) {
        assert.equal(width, 256);
        assert.equal(height, 256);
        canvases.push(this);
      }
      getContext(kind: string) {
        assert.equal(kind, '2d');
        return context;
      }
    },
    async createImageBitmap(blob: Blob | OffscreenCanvas) {
      if (!(blob instanceof Blob)) {
        events.push('snapshot');
        await Promise.resolve();
        assert.equal(blob.width, 256, 'keep the canvas alive until the snapshot resolves');
        if (mode === 'snapshot-cancel') controller.abort();
        if (mode === 'snapshot-failure') throw new Error('snapshot failed');
        return overview;
      }
      assert.ok(blob.size > 0);
      events.push('decode');
      if (mode === 'cancel') controller.abort();
      return { close: () => events.push('close') };
    },
  };
  for (const [name, value] of Object.entries(browserStubs)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }

  const tile = { z: 5, x: 5, y: 28 };
  assert.equal(await read(tile, controller.signal), overview);
  assert.equal(context.imageSmoothingQuality, 'high');
  assert.deepEqual(events, ['decode', 'draw', 'close', 'decode', 'draw', 'close', 'snapshot']);

  events.length = 0;
  mode = 'cancel';
  await assert.rejects(read(tile, controller.signal), { name: 'AbortError' });
  assert.deepEqual(events, ['decode', 'close']);

  events.length = 0;
  controller = new AbortController();
  mode = 'draw-failure';
  await assert.rejects(read(tile, controller.signal), /draw failed/);
  assert.deepEqual(events, ['decode', 'draw', 'close']);

  events.length = 0;
  controller = new AbortController();
  mode = 'snapshot-cancel';
  await assert.rejects(read(tile, controller.signal), { name: 'AbortError' });
  assert.deepEqual(events, ['decode', 'draw', 'close', 'decode', 'draw', 'close', 'snapshot', 'close-overview']);

  events.length = 0;
  controller = new AbortController();
  mode = 'snapshot-failure';
  await assert.rejects(read(tile, controller.signal), /snapshot failed/);
  assert.deepEqual(events, ['decode', 'draw', 'close', 'decode', 'draw', 'close', 'snapshot']);
  assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'release canvases on every exit');
});
