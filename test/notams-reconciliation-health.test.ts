import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotamStore } from '../tools/info-server/notams/store';
import { NotamReconciliation } from '../tools/info-server/notams/reconciliation';
import { NOTAM_FULL_SYNC_MAX_AGE } from '../tools/info-server/notams/policy';
import { NotamError } from '../tools/info-server/notams/error';

test('reconciliation history survives restart, reports interruption, and never modifies admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-history-'));
  let now = 100000, store = new NotamStore(directory, 'staging', () => now);
  try {
    await store.restore(); const budget = await readFile(join(directory, 'budget.json'), 'utf8');
    let history = new NotamReconciliation(store, () => now); await history.restore();
    assert.equal(history.status(null, false).state, 'unavailable');
    const attemptedAt = await history.started(); assert.equal(history.status(null, true).state, 'pending');
    await store.close(); store = new NotamStore(directory, 'staging', () => now); await store.restore();
    history = new NotamReconciliation(store, () => now); await history.restore();
    assert.equal(history.status(null, false).error, 'reconciliation-interrupted');
    now += 1000; await history.failed(attemptedAt, new NotamError('source-http-502'));
    const saved = history.status(90000, false);
    history = new NotamReconciliation(store, () => now); await history.restore();
    assert.deepEqual(history.status(90000, false), saved);
    assert.equal(history.status(attemptedAt + 1, false).error, null, 'a complete newer generation resolves the failure');
    assert.equal(history.status(now - NOTAM_FULL_SYNC_MAX_AGE, false).overdue, true);
    assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), budget);
    await writeFile(join(directory, 'reconciliation.json'), '{bad');
    history = new NotamReconciliation(store, () => now); await history.restore();
    assert.equal(history.status(now, false).error, 'reconciliation-history-invalid');
    assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), budget);
    await history.started(); assert.equal(history.status(now, false).error, null);
    await rm(join(directory, 'reconciliation.json')); await mkdir(join(directory, 'reconciliation.json'));
    await history.started();
    assert.equal(history.status(now, false).error, 'reconciliation-history-unavailable');
    assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), budget);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
test('orphaned reconciliation history cannot silently provision a new source allowance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-orphan-history-')), store = new NotamStore(directory, 'staging');
  try {
    await writeFile(join(directory, 'reconciliation.json'), '{}');
    await assert.rejects(store.restore(), /state-recovery-required/);
    assert.equal((await readdir(directory)).includes('budget.json'), false);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
