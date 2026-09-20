import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { withAbort } from '../src/core/data/abort';

test('an already cancelled consumer cannot receive a cached result', async () => {
  const signal = AbortSignal.abort(new Error('Paused'));
  await assert.rejects(withAbort(Promise.resolve('cached'), signal), error => error === signal.reason);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('cancellation before a ready result is delivered still stops the consumer', async () => {
  const controller = new AbortController();
  const result = withAbort(Promise.resolve('cached'), controller.signal);
  controller.abort(new Error('Paused'));
  await assert.rejects(result, error => error === controller.signal.reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancelling one consumer leaves shared work available to another', async () => {
  let finish!: (value: string) => void;
  const work = new Promise<string>(resolve => { finish = resolve; });
  const first = new AbortController(), second = new AbortController();
  const cancelled = withAbort(work, first.signal), continuing = withAbort(work, second.signal);
  first.abort();
  await assert.rejects(cancelled, error => error === first.signal.reason);
  finish('ready');
  assert.equal(await continuing, 'ready');
  assert.equal(getEventListeners(first.signal, 'abort').length, 0);
  assert.equal(getEventListeners(second.signal, 'abort').length, 0);
});

test('failed and cancelled shared work releases listeners and handles late rejection', async () => {
  const controller = new AbortController();
  await assert.rejects(withAbort(Promise.reject(new Error('Read failed')), controller.signal), /Read failed/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  let fail!: (reason: Error) => void;
  const work = new Promise<never>((_resolve, reject) => { fail = reject; });
  const cancelled = withAbort(work, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, error => error === controller.signal.reason);
  fail(new Error('Late failure'));
  await new Promise(resolve => setImmediate(resolve));
});
