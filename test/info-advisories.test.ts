import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeatherCache } from '../tools/info-server/cache';
import { createAdvisoryWarming } from '../tools/info-server/advisories';
import { createUpstream, digest } from '../tools/info-server/upstream';
import { advisoryResource, HttpError } from '../tools/info-server/routes';

test('advisory background failures remain visible, independent, coalesced and recover with original source times', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'info-advisories-')), shutdown = new AbortController();
  let now = 100000, failing = true, calls = 0;
  const logs: string[] = [], body = Buffer.from('[]');
  const cache = new WeatherCache({ directory, now: () => now, maxBytes: 1024 * 1024, load: async resource => {
    calls++;
    if (failing && resource.url.includes('/sigmet.json')) throw new HttpError(502, 'fixture upstream failure');
    return { body, sha256: digest(body), checkedAt: now, status: 200, headers: { 'content-type': 'application/json' } };
  } });
  const create = () => createAdvisoryWarming(cache, shutdown.signal, { now: () => now, log: line => logs.push(line) });
  let warming = create();
  try {
    await cache.restore(); warming.refresh(); warming.refresh(); await warming.close();
    assert.equal(calls, 3); assert.equal(warming.status.sigmet!.error, 'upstream-unavailable');
    assert.equal(warming.status.cwa!.ready, true); assert.equal(warming.status.sigmet!.checkedAt, null);
    now += 30000; warming.refresh(); await warming.close();
    assert.equal(logs.length, 1, 'unchanged failure is not logged each round');
    failing = false; now += 30000; warming.refresh(); await warming.close();
    assert.equal(warming.status.sigmet!.error, null); assert.equal(warming.status.sigmet!.checkedAt, now);
    assert.equal(logs.at(-1), 'Advisory sigmet recovered');
    warming = create(); now++; await warming.restore();
    assert.equal(warming.status.sigmet!.checkedAt, now - 1, 'restore cannot freshen saved observations');
    shutdown.abort(); const before = calls; warming.refresh(); await warming.close(); assert.equal(calls, before);
  } finally { shutdown.abort(); await warming.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); }
});
test('transport and interrupted bodies are classified as upstream failures', async () => {
  for (const stream of [false, true]) {
    const upstream = createUpstream({ spacing: 0, signal: new AbortController().signal, fetch: async () => {
      if (!stream) throw new TypeError('private transport details');
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('socket reset')); } }));
    } });
    await assert.rejects(upstream(advisoryResource('sigmet')),
      cause => cause instanceof HttpError && cause.status === 502 && !cause.message.includes('private'));
  }
});
