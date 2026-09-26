import assert from 'node:assert/strict';
import test from 'node:test';
import { workerFailure, workerError } from '../tools/weather-server/worker-protocol';
import { WeatherSourceError } from '../tools/weather-server/source-error';
import { workerJob, workerModule } from '../tools/weather-server/worker-job';

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
