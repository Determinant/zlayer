import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTfrService } from '../tools/info-server/notams/tfr-service';
import corpus from './fixtures/tfrs.json' with { type: 'json' };

const START = Date.parse('2026-10-05T21:00Z');
const index = corpus.cases.slice(0, 2).map(c => c.index);

test('TFR Retry-After survives rapid restarts and only one state owner may collect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-admission-')); let now = START, calls = 0;
  const options = { directory, now: () => now, signal: new AbortController().signal, fetch: async () => {
    calls++; return new Response(null, { status: 503, headers: { 'Retry-After': new Date(START + 3600_000).toUTCString() } });
  } };
  try {
    let service = createTfrService(options); await service.restore(); await service.refresh();
    assert.equal(service.status.nextAttemptAt, START + 3600_000);
    const other = createTfrService(options); await other.restore(); await other.refresh();
    assert.equal(other.status.error, 'storage-unavailable'); await other.close(); assert.equal(calls, 1);
    await service.close();
    for (let i = 0; i < 36; i++) {
      now += 5000; service = createTfrService(options); await service.restore(); await service.refresh();
      assert.equal(service.status.error, 'refresh-failed'); await service.close();
    }
    assert.equal(calls, 1);
    now = START + 3600_000; service = createTfrService(options); await service.restore(); await service.refresh(); await service.close();
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('TFR failed detail work survives restart without publishing partial national coverage or redownloading completed details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-progress-')); let now = START, fail = true;
  const calls: { url: string; at: number }[] = [];
  const options = { directory, now: () => now, wait: async (ms: number) => { now += ms; }, signal: new AbortController().signal,
    fetch: async (input: string | URL | Request) => {
      const url = String(input); calls.push({ url, at: now }); assert.equal(new URL(url).origin, 'https://tfr.faa.gov');
      if (url.endsWith('getTfrList')) return Response.json(index);
      const c = corpus.cases.find(c => url.includes(c.index.notam_id.replace('/', '_')))!;
      if (fail && c === corpus.cases[1]) return new Response(null, { status: 502 });
      return new Response(c.xml);
    } };
  let service = createTfrService(options);
  try {
    await service.restore(); await service.refresh(); assert.equal(service.read(), undefined);
    assert.equal(calls.length, 3); await service.close();
    now += 180_000; fail = false; service = createTfrService(options); await service.restore(); await service.refresh();
    assert.equal(service.read()!.notices.length, 2); assert.equal(service.read()!.error, undefined);
    assert.equal(calls.length, 5); assert.equal(calls.filter(c => c.url.includes(index[0]!.notam_id.replace('/', '_'))).length, 1);
    assert.ok(calls.every((c, i) => !i || c.at - calls[i - 1]!.at >= 1000));
    await service.close(); service = createTfrService(options); await service.restore(); await service.refresh();
    assert.equal(calls.length, 5, 'a normal restart cannot bypass the next index deadline');
    assert.equal(service.read()!.notices.length, 2);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('TFR admission corruption stops upstream work without deleting the last complete snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-corrupt-')); let calls = 0;
  const options = { directory, now: () => START, signal: new AbortController().signal,
    fetch: async () => { calls++; return Response.json([]); } };
  let service = createTfrService(options);
  try {
    await service.restore(); await service.refresh(); await service.close();
    const path = join(directory, 'tfrs', 'admission.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...saved, nextAt: 0 }));
    service = createTfrService(options); await service.restore(); await service.refresh();
    assert.equal(calls, 1); assert.equal(service.status.error, 'storage-unavailable');
    assert.deepEqual(service.read()!.notices, []); assert.equal(service.read()!.checkedAt, START);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('TFR close aborts its own in-flight request and preserves a conservative restart deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-close-')), parent = new AbortController();
  let started!: () => void, requestSignal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const service = createTfrService({ directory, now: () => START, signal: parent.signal, fetch: async (_url, init) => {
    requestSignal = init!.signal!; started(); return new Promise((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true }));
  } });
  try {
    await service.restore(); void service.refresh(); await ready; await service.close();
    assert.equal(requestSignal!.aborted, true); assert.equal(parent.signal.aborted, false);
    const budget = JSON.parse(await readFile(join(directory, 'tfrs', 'admission.json'), 'utf8'));
    assert.equal(budget.nextAt, START + 210_000); assert.equal(budget.failed, true);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
