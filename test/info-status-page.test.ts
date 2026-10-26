import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createInfoServer } from '../tools/info-server/server';
import { prefersStatusPage, renderStatusPage, statusPagePolicy, statusRefreshScript } from '../tools/info-server/status-page';
import { notamSnapshot, NOTAM_NOW } from './fixtures/notams';

function readiness() {
  const source = { available: true, fresh: true, coverage: 'complete' as const, checkedAt: NOTAM_NOW, nextAttemptAt: NOTAM_NOW + 60_000, error: null };
  return { ready: true, state: 'ready', sources: { clouds: source, radar: { ...source, coverage: 'partial' as const }, notams: source },
    problems: [] as { product: string; reason: string; severity: 'warning' | 'error' }[], warnings: [] as { product: string; reason: string; severity: 'warning' | 'error' }[],
    notices: [] as { product: string; reason: string; severity: 'info'; count: number }[] };
}

test('status page preserves readiness, expected partial coverage and nonblocking warnings', () => {
  const value = readiness(), feed = notamSnapshot().feed;
  let html = renderStatusPage(value, feed, NOTAM_NOW);
  assert.match(html, /<title>Healthy \| ZLayer/);
  assert.match(html, /Partial coverage/);
  assert.match(html, /0 blocking NOTAM issues/);
  value.notices.push({ product: 'notams', reason: 'association-metadata', severity: 'info', count: 1 });
  html = renderStatusPage(value, { ...feed, unresolvedRecords: 1, blockingRecords: 0 }, NOTAM_NOW);
  assert.match(html, /<title>Healthy \| ZLayer/);
  assert.match(html, /0 blocking NOTAM issues · 1 metadata discrepancy/);
  assert.match(html, /1 metadata discrepancy; no supported queries affected/);
  assert.doesNotMatch(html, />Warning<|Ready with warnings/);
  html = renderStatusPage(value, { ...feed, unresolvedRecords: 1, blockingRecords: 0,
    historicalIssues: 1, historicalMetadataIssues: 1 }, NOTAM_NOW);
  assert.match(html, /<title>Healthy \| ZLayer/);
  assert.match(html, /0 blocking NOTAM issues · 1 metadata discrepancy/);
  assert.doesNotMatch(html, />Warning<|Ready with warnings|1 historical issues/);
  value.warnings.push({ product: 'notams', reason: 'historical-source-issues', severity: 'warning' });
  html = renderStatusPage(value, { ...feed, unresolvedRecords: 2, blockingRecords: 0, historicalIssues: 1 }, NOTAM_NOW);
  assert.match(html, /<title>Ready with warnings/);
  assert.match(html, /0 blocking NOTAM issues · 1 metadata discrepancy · 1 historical issues/);
  value.ready = false;
  value.problems.push({ product: 'notams.reconciliation', reason: 'full-sync-overdue', severity: 'warning' });
  html = renderStatusPage(value, feed, NOTAM_NOW);
  assert.match(html, /<title>Needs attention/);
  assert.match(html, /NOTAM full sync: full-sync-overdue/);
  assert.match(html, /class="bad">Attention/);
  value.sources.clouds.fresh = false;
  value.sources.radar.available = false;
  html = renderStatusPage(value, feed, NOTAM_NOW);
  assert.match(html, />Stale<\/td>/);
  assert.match(html, />Unavailable<\/td>/);
});

test('status HTML escapes source messages and uses a policy matching its static script and style', () => {
  const value = readiness();
  value.ready = false;
  value.problems.push({ product: 'clouds', reason: '<script>alert("source")</script>', severity: 'error' });
  const html = renderStatusPage(value, { ...notamSnapshot().feed, enabled: false }, NOTAM_NOW, 'javascript:alert(1)');
  assert.doesNotMatch(html, /<script>alert|href="javascript:/);
  assert.match(html, /&lt;script&gt;alert\(&quot;source&quot;\)/);
  assert.match(html, /NOTAM collection disabled/);
  assert.match(html, />Disabled<\/td>/);
  for (const tag of ['style', 'script']) {
    const content = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))![1]!;
    assert.ok(statusPagePolicy.includes("'sha256-" + createHash('sha256').update(content).digest('base64') + "'"));
  }
  assert.match(html, /<script data-cfasync="false">/);
});

test('status HTTP reads are local, uncached, and support HEAD without changing health JSON', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-status-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const app = await createInfoServer({ directory, startUpdates: false, now: () => NOTAM_NOW,
    fetch: async () => { calls++; throw new Error('No source requests'); } });
  t.after(() => app.close());
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const before = await (await fetch(origin + '/api/weather/healthz')).json();
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(origin + '/api/weather/healthz', { method, headers: { Accept: 'text/html' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('content-security-policy'), statusPagePolicy);
    assert.equal(response.headers.get('vary'), 'Accept');
    const body = await response.text();
    if (method === 'HEAD') assert.equal(body, '');
    else { assert.match(body, /Needs attention/); assert.match(body, /Clouds/); assert.match(body, /NOTAM collection disabled/); }
  }
  assert.equal((await fetch(origin + '/api/weather/healthz', { method: 'POST' })).status, 405);
  const raw = await fetch(origin + '/api/weather/healthz?format=json', { headers: { Accept: 'text/html' } });
  assert.equal(raw.headers.get('content-type'), 'application/json');
  assert.deepEqual((await raw.json()).readiness, before.readiness);
  const after = await (await fetch(origin + '/api/weather/healthz')).json();
  assert.deepEqual(after.readiness, before.readiness);
  assert.deepEqual(after.notams, before.notams);
  assert.equal(calls, 0);
});

test('health content negotiation preserves JSON probes and respects explicit media preferences', () => {
  for (const accept of [undefined, '', '*/*', 'application/json', 'text/html;q=0', 'text/html;q=invalid',
    'text/html;q=0.5,application/json', 'text/html;q=0.5,*/*;q=1']) assert.equal(prefersStatusPage(accept), false, accept);
  for (const accept of ['text/html', 'text/html,application/xhtml+xml,*/*;q=0.8',
    'application/json;q=0.5,text/html;q=0.9', 'TEXT/HTML']) assert.equal(prefersStatusPage(accept), true, accept);
});

test('status refresh hides stale snapshots, recovers, pauses hidden tabs, and reloads changed UI assets', async () => {
  let now = 0, failed = true, requests = 0, reloads = 0, version = 'first';
  const intervals = new Map<number, () => unknown>(), events = new Map<string, (event?: unknown) => unknown>();
  const connection = { hidden: true, textContent: '' };
  const updated = { textContent: 'old', replaceWith(next: { textContent: string }) { this.textContent = next.textContent; } };
  type Snapshot = { hidden: boolean; dataset: { infoStatus: string; infoVersion: string }; replaceWith(next: Snapshot): void };
  function snapshot(): Snapshot {
    return { hidden: false, dataset: { infoStatus: '1', infoVersion: version }, replaceWith(next: Snapshot) { current = next; } };
  }
  let current = snapshot();
  const document = { hidden: false, title: 'Healthy | ZLayer',
    getElementById: (id: string): unknown => id === 'snapshot' ? current : id === 'connection' ? connection : updated,
    addEventListener: (name: string, callback: () => unknown) => events.set(name, callback) };
  runInNewContext(statusRefreshScript, { document, window: { location: { reload: () => { reloads++; } },
    addEventListener: (name: string, callback: () => unknown) => events.set(name, callback) },
    performance: { now: () => now }, AbortController, setTimeout, clearTimeout,
    setInterval: (callback: () => unknown, ms: number) => intervals.set(ms, callback),
    fetch: async () => { requests++; if (failed) throw new Error('offline');
      return { ok: true, headers: new Map([['content-type', 'text/html; charset=utf-8']]), text: async () => 'page' }; },
    DOMParser: class { parseFromString() { return { title: 'Healthy | ZLayer', getElementById: (id: string) => id === 'snapshot' ? snapshot() : { textContent: 'new' } }; } },
  });
  await intervals.get(30000)!();
  assert.equal(current.hidden, true); assert.equal(connection.hidden, false);
  assert.equal(document.title, 'Status unavailable | ZLayer');
  failed = false; await intervals.get(30000)!();
  assert.equal(current.hidden, false); assert.equal(connection.hidden, true);
  assert.equal(updated.textContent, 'new');
  document.hidden = true; await intervals.get(30000)!(); assert.equal(requests, 2);
  now = 46000; intervals.get(1000)!(); assert.equal(current.hidden, true);
  document.hidden = false; events.get('visibilitychange')!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(current.hidden, false); assert.equal(requests, 3);
  events.get('offline')!(); assert.equal(current.hidden, true);
  version = 'second'; await intervals.get(30000)!();
  assert.equal(reloads, 1); assert.equal(current.dataset.infoVersion, 'first');
});
