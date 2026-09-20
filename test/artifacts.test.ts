import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { blobSha256, readArtifact, verifyBlob } from '../src/core/storage/artifacts';
import { InvalidDataError } from '../src/core/data/errors';

test('artifact inspection distinguishes corruption from transient storage failures without deleting', async () => {
  const cache = { match: async () => new Response('value') };
  assert.equal((await readArtifact(undefined, 'key', async () => 1)).state, 'unavailable');
  assert.deepEqual(await readArtifact({ match: async () => undefined }, 'key', async () => 1), { state: 'missing' });
  assert.equal((await readArtifact(cache, 'key', async () => { throw new InvalidDataError('bad'); })).state, 'invalid');
  assert.equal((await readArtifact(cache, 'key', async () => { throw new DOMException('busy', 'NotReadableError'); })).state, 'unavailable');
});

test('incremental artifact hashing matches SHA-256 across chunk boundaries without reading the whole blob', async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 71).map((_, index) => index % 251);
  const blob = new Blob([bytes]);
  blob.arrayBuffer = async () => { throw new Error('whole-file allocation'); };
  assert.equal(await blobSha256(blob), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(await blobSha256(new Blob()), createHash('sha256').digest('hex'));
});

test('one immutable Blob is hashed once across concurrent callers and different verification expectations', async t => {
  const blob = new Blob(['verified bytes']);
  const expected = createHash('sha256').update('verified bytes').digest('hex');
  const slice = t.mock.method(blob, 'slice');
  const [first, second] = await Promise.all([blobSha256(blob), verifyBlob(blob, { sha256: expected }, 'File')]);
  assert.equal(first, expected);
  assert.equal(second, expected);
  assert.equal(await blobSha256(blob), expected);
  await assert.rejects(verifyBlob(blob, { sha256: 'a'.repeat(64) }, 'File'), /SHA-256 mismatch/);
  await assert.rejects(verifyBlob(blob, { byteLength: blob.size + 1 }, 'File'), /size mismatch/);
  assert.equal(slice.mock.calls.length, 1);
  await assert.rejects(verifyBlob(new Blob(['replacement']), { sha256: expected }, 'File'), /SHA-256 mismatch/);
});

test('failed Blob reads are evicted and can be hashed again after the read recovers', async t => {
  const blob = new Blob(['recoverable']);
  const slice = blob.slice.bind(blob);
  let reads = 0;
  t.mock.method(blob, 'slice', (...args: Parameters<Blob['slice']>) => {
    if (++reads === 1) throw new DOMException('temporarily unreadable', 'NotReadableError');
    return slice(...args);
  });
  await assert.rejects(blobSha256(blob), { name: 'NotReadableError' });
  assert.equal(await blobSha256(blob), createHash('sha256').update('recoverable').digest('hex'));
  assert.equal(reads, 2);
});

test('concurrent streamed hashes keep separate state and release a slot after a failed read', async () => {
  const values = ['first', 'second', 'third', 'fourth'].map(value => value.repeat(250_000));
  const broken = new Blob(['unreadable']);
  broken.slice = () => { throw new DOMException('storage temporarily unavailable', 'NotReadableError'); };
  const results = await Promise.allSettled([blobSha256(broken), ...values.map(value => blobSha256(new Blob([value])))]);
  assert.equal(results[0]!.status, 'rejected');
  for (const [index, value] of values.entries()) {
    assert.deepEqual(results[index + 1], { status: 'fulfilled', value: createHash('sha256').update(value).digest('hex') });
  }
});

test('artifact verification falls back to portable SHA-256 when WebAssembly is unavailable', async t => {
  t.mock.method(WebAssembly, 'instantiate', async () => { throw new Error('WebAssembly disabled'); });
  const bytes = new Uint8Array(1024 * 1024 + 13).fill(71);
  const blob = new Blob([bytes]);
  blob.arrayBuffer = async () => { throw new Error('whole-file allocation'); };
  assert.equal(await blobSha256(blob), createHash('sha256').update(bytes).digest('hex'));
});
