import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';

import { createPackageReader, extractPackageTiles } from '../src/layers/charts/package-reader.js';

const SQL = await initSqlJs();

function archive(rows: Array<[number, number, number, Uint8Array]>) {
  const db = new SQL.Database();
  db.run('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)');
  for (const row of rows) db.run('INSERT INTO tiles VALUES (?, ?, ?, ?)', row);
  return db;
}

test('extracts the complete package, closes SQLite, and keeps reusable bytes after transfer', async () => {
  const db = archive([[5, 5, 3, new Uint8Array([12, 34])], [5, 6, 3, new Uint8Array([56])]]);
  const rows = extractPackageTiles(db);
  db.close();
  assert.deepEqual(rows.map(({z,x,y}) => ({z,x,y})), [{z:5,x:5,y:28},{z:5,x:6,y:28}]);
  const reader = createPackageReader(rows);
  const tile = {z:5,x:5,y:28}, signal = new AbortController().signal;
  const first = await reader.read(tile, signal) as ArrayBuffer;
  structuredClone(first, {transfer:[first]});
  assert.equal(first.byteLength, 0);
  assert.deepEqual(new Uint8Array(await reader.read(tile, signal) as ArrayBuffer), new Uint8Array([12,34]));
  assert.equal(await reader.read({z:5,x:7,y:28}, signal), null);
  assert.equal(await reader.read({z:4,x:2,y:14}, signal), null);
  reader.dispose();
  assert.equal(await reader.read(tile, signal), null);
});

test('package overzoom respects XYZ quadrants, native holes, and cancellation', async () => {
  const bitmap = {} as ImageBitmap;
  let rendered = 0;
  const reader = createPackageReader([{z:5,x:5,y:28,data:new Uint8Array([42]).buffer}], async parts => {
    assert.deepEqual(parts, [{data:new Uint8Array([42]).buffer,x:-256,y:-768,size:1024}]);
    rendered++;
    return bitmap;
  });
  const tile = {z:7,x:21,y:115};
  assert.equal(await reader.read(tile, new AbortController().signal), bitmap);
  assert.equal(await reader.read({...tile,x:24}, new AbortController().signal), null);
  await assert.rejects(reader.read(tile, AbortSignal.abort()), {name:'AbortError'});
  assert.equal(rendered, 1);
});

test('rejects malformed, mixed-zoom, duplicate, empty, and oversized tile tables', () => {
  const data = new Uint8Array([42]);
  const cases: Array<Array<[number,number,number,Uint8Array]>> = [
    [], [[5,5,3,data],[6,5,3,data]], [[5,5,3,data],[5,5,3,data]],
    [[25,0,0,data]], [[5,32,3,data]], [[5,5,-1,data]], [[5,5,3,new Uint8Array()]],
    Array.from({length:65},(_,i)=>[7,i,3,data]),
  ];
  for (const rows of cases) {
    const db = archive(rows);
    try { assert.throws(() => extractPackageTiles(db), /Chart package/); }
    finally { db.close(); }
  }
});
