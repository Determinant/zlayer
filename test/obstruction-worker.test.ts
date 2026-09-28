import assert from 'node:assert/strict';
import test from 'node:test';
import { createObstructionWorker } from '../src/layers/obstructions/worker-data';
import { ObstructionIndex } from '../src/layers/obstructions/data';
import type { LoadedObstructions } from '../src/layers/obstructions/api';
import type { ObstructionRequest } from '../src/layers/obstructions/types';

const query: ObstructionRequest = { manifestUrl: 'https://example.test/manifest.json', bounds: [-1, -1, 1, 1], segments: [], zoom: 10 };
test('worker revalidates on recovery, coalesces pending loads and preserves its last validated index on failure', async () => {
  let loads = 0, fail = false;
  const index = new ObstructionIndex(0); index.finish();
  let saved: LoadedObstructions = { index, identity: 'old', sourceDate: '2026-09-18' };
  const previous: (LoadedObstructions | undefined)[] = [];
  const worker = createObstructionWorker(async (_url, current) => {
    loads++; previous.push(current);
    if (fail) throw new Error('Unavailable');
    return saved;
  });
  await Promise.all([worker.query(query), worker.query(query)]);
  assert.equal(loads, 1);
  saved = { index, identity: 'new', sourceDate: '2026-09-27' };
  assert.equal((await worker.query(query)).sourceDate, '2026-09-18');
  assert.equal(loads, 1, 'viewport changes do not fetch the rolling manifest');
  assert.equal((await worker.query({ ...query, revalidate: true })).sourceDate, '2026-09-27');
  assert.equal(previous[1]?.identity, 'old');
  fail = true;
  await assert.rejects(worker.query({ ...query, revalidate: true }), /Unavailable/);
  assert.equal((await worker.query(query)).sourceDate, '2026-09-27');
  fail = false;
  await worker.query({ ...query, revalidate: true });
  assert.equal(loads, 4, 'a failed refresh remains retryable');
});
