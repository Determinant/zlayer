import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { releaseProxy, wrap } from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js';
import type { SqliteComlinkMod } from 'sql.js-httpvfs/dist/sqlite.worker';

const workerPath = createRequire(import.meta.url).resolve('sql.js-httpvfs/dist/sqlite.worker.js');

test('the chart reader speaks the bundled SQLite worker protocol', { timeout: 5_000 }, async (t) => {
  // Execute the shipped browser worker unchanged, providing only its messaging API.
  // Checking the real bundle catches Comlink wire-format changes that type checks miss.
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const listeners = new Map();
    globalThis.self = globalThis;
    globalThis.addEventListener = (type, listener) => {
      const wrapped = data => listener({ data });
      listeners.set(listener, wrapped);
      parentPort.on(type, wrapped);
    };
    globalThis.removeEventListener = (type, listener) => {
      parentPort.off(type, listeners.get(listener));
      listeners.delete(listener);
    };
    globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
    require(${JSON.stringify(workerPath)});
  `, { eval: true });
  t.after(async () => { await worker.terminate(); });
  const remote = wrap<SqliteComlinkMod>(nodeEndpoint(worker));

  assert.equal(await remote.inited, false);
  assert.equal(await remote.evalCode('return 42'), 42);
  assert.equal(await remote.getStats(), null);
  await assert.rejects(remote.evalCode('throw new Error("worker error")'), /worker error/);
  await remote[releaseProxy]();
});
