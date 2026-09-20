import assert from 'node:assert/strict';
import test from 'node:test';

import { stationIdBatches } from '../src/layers/metar-taf/metar/requests.js';

test('normalizes, deduplicates, and batches every requested METAR station', () => {
  const stationIds = [' khwd ', 'KSFO', 'khwd', '', ...Array.from(
    { length: 203 },
    (_, index) => `K${index.toString().padStart(3, '0')}`,
  )];
  const batches = stationIdBatches(stationIds, 100);
  const flattened = batches.flat();

  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 5]);
  assert.equal(flattened[0], 'KHWD');
  assert.equal(flattened[1], 'KSFO');
  assert.equal(new Set(flattened).size, flattened.length);
});

test('rejects an invalid batch size', () => {
  assert.throws(() => stationIdBatches(['KHWD'], 0), /positive integer/);
});
