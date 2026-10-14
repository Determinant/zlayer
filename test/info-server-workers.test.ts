import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { workerFailure, workerError, WorkerInputError } from '../tools/info-server/worker-protocol';
import { WeatherSourceError } from '../tools/info-server/source-error';
import { workerJob, workerModule } from '../tools/info-server/worker-job';
import { parseSurfaceCatalog } from '../src/layers/weather-awc/progs/source';
import { surfaceCatalog, surfaceChart } from './fixtures/wpc';
import { WEATHER_NOW } from './fixtures/awc-advisories';

test('worker failures preserve explicit source classifications without inferring them from messages', () => {
  for (const cause of [new Error('future source failed'), new WeatherSourceError('bad bytes'), new WeatherSourceError('ahead', 'future-source')]) {
    const reply = workerFailure(cause);
    assert.equal(reply.type, 'error');
    if (reply.type !== 'error') throw new Error('Expected error reply');
    const error = workerError(reply.error);
    assert.equal(error.message, cause.message);
    assert.equal(error instanceof WeatherSourceError, cause instanceof WeatherSourceError);
    if (error instanceof WeatherSourceError && cause instanceof WeatherSourceError) assert.equal(error.code, cause.code);
  }
  assert.equal(workerModule('file:///app/radar.ts?revision=1', 'radar-worker').href, 'file:///app/radar-worker.ts');
  assert.equal(workerModule('file:///app/shared-123.js', 'radar-worker').href, 'file:///app/radar-worker.js');
});

test('one-shot workers send input, propagate typed failures, and release cancelled jobs', async () => {
  const source = new URL('data:text/javascript,' + encodeURIComponent(`
    import {parentPort} from 'node:worker_threads';
    parentPort.once('message', value => parentPort.postMessage(value));
  `));
  const controller = new AbortController();
  assert.equal(await workerJob(source, { type: 'done', value: 42 }, controller.signal), 42);
  await assert.rejects(workerJob(source, { type: 'error', error: { code: 'processing', message: 'future worker failure' } }, controller.signal),
    error => error instanceof Error && !(error instanceof WeatherSourceError));
  controller.abort();
  await assert.rejects(workerJob(source, {}, controller.signal), { name: 'AbortError' });

  const waiting = new URL('data:text/javascript,' + encodeURIComponent(`
    import {parentPort} from 'node:worker_threads';
    parentPort.once('message', () => setInterval(() => {}, 1000));
  `));
  const cancelled = new AbortController();
  const job = workerJob(waiting, {}, cancelled.signal);
  cancelled.abort();
  await assert.rejects(job, { name: 'AbortError' });

  const crashed = new URL('data:text/javascript,' + encodeURIComponent(`
    import {parentPort} from 'node:worker_threads';
    parentPort.once('message', () => { throw new Error('Worker crashed'); });
  `));
  await assert.rejects(workerJob(crashed, {}, new AbortController().signal), { message: 'Worker crashed' });
});

test('surface workers identify malformed source members without quarantining local preparation failures', async () => {
  const worker = new URL('../tools/info-server/progs-worker.ts', import.meta.url), signal = new AbortController().signal;
  const chart = parseSurfaceCatalog(JSON.stringify(surfaceCatalog()), WEATHER_NOW)[0]!;
  const text = JSON.stringify(surfaceChart(chart.file));
  const job = { chart, text, checkedAt: WEATHER_NOW, sourceHash: createHash('sha256').update(text).digest('hex') };
  const invalid = surfaceChart(chart.file);
  invalid.features.find(f => f.properties.type === 1)!.geometry = { type: 'LineString', coordinates: [[0, 0], [0, 91]] };
  await assert.rejects(workerJob(worker, { product: 'analysis', jobs: [job, { ...job, text: JSON.stringify(invalid) }, { ...job, text: '{' }] }, signal),
    error => error instanceof WorkerInputError && JSON.stringify(error.inputIndices) === '[1,2]' &&
      error.message.includes(chart.file) && error.message.includes('feature'));
  // A bad internally supplied hash fails canonical output validation. The
  // unchanged valid input document is not implicated by that processing error.
  await assert.rejects(workerJob(worker, { product: 'analysis', jobs: [{ ...job, sourceHash: 'invalid' }] }, signal),
    error => error instanceof Error && !(error instanceof WorkerInputError) &&
      error.message.includes('Surface preparation failed') && error.message.includes(chart.file));
});
