import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInfoServer } from '../tools/info-server/server';

test('failed weather startup releases source locks before rejecting server creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'info-startup-failure-'));
  const options = { startUpdates: false, notams: { enabled: false, directory: join(directory, 'state') } };
  try {
    await writeFile(join(directory, 'weather'), 'Not a cache directory');
    await assert.rejects(createInfoServer({ ...options, directory: join(directory, 'weather') }));
    const recovered = await createInfoServer({ ...options, directory: join(directory, 'repaired') });
    try { assert.equal(recovered.tfrs.status.error, null, 'the failed instance cannot keep the TFR writer lock'); }
    finally { await recovered.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shutdown still closes the listener and other producers when one cleanup fails', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'info-shutdown-failure-'));
  let started!: (signal: AbortSignal) => void;
  const waiting = new Promise<AbortSignal>(resolve => { started = resolve; });
  const app = await createInfoServer({ directory, startUpdates: false, fetch: async (_input, init) => {
    const signal = init!.signal!; started(signal);
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    throw new Error('Unreachable');
  } });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const request = fetch(`http://127.0.0.1:${address.port}/api/weather/metars.geojson?ids=KSFO`)
      .then(response => response.arrayBuffer()).catch(() => {});
    const sourceSignal = await waiting;
    const closeTfr = app.tfrs.close;
    app.tfrs.close = async () => { await closeTfr(); throw new Error('Fixture cleanup failure'); };
    await assert.rejects(app.close(), AggregateError);
    assert.equal(sourceSignal.aborted, true); assert.equal(app.server.listening, false);
    await request;
    const recovered = await createInfoServer({ directory, startUpdates: false });
    try { assert.equal(recovered.tfrs.status.error, null); }
    finally { await recovered.close(); }
  } finally { await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
