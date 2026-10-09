import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TFR_DETAIL_REFRESH_MS, TFR_STALE_MS } from '@zlayer/contracts';
import { createTfrService } from '../tools/info-server/notams/tfr-service';
import corpus from './fixtures/tfrs.json' with { type: 'json' };

const START = Date.parse('2026-10-05T21:00Z');
const fixtures = (count: number) => Array.from({ length: count }, (_, i) => {
  const number = String(1000 + i), original = corpus.cases[0]!;
  return { index: { ...original.index, notam_id: `6/${number}`, gid: `6/${number}` },
    xml: original.xml.replaceAll('6654', number) };
});

for (const count of [2, 8, 16, 20]) test(`${count} clustered TFR deadlines remain fresh through successive slow request queues`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-queue-')), entries = fixtures(count);
  let now = START, slow = false;
  const reads = new Set<string>();
  const check = () => {
    for (const notice of service.read()?.notices ?? []) {
      assert.ok(now - notice.detailCheckedAt! < TFR_DETAIL_REFRESH_MS, `overdue ${notice.id}: ${now - notice.detailCheckedAt!}ms`);
    }
  };
  const service = createTfrService({ directory, signal: new AbortController().signal, now: () => now,
    wait: async ms => { now += ms; check(); }, fetch: async input => {
      if (slow) now += 29_999;
      check();
      const url = String(input);
      if (url.endsWith('getTfrList')) return Response.json(entries.map(entry => entry.index));
      assert.ok(!reads.has(url), 'one attempt per member per round'); reads.add(url);
      return new Response(entries.find(entry => url.includes(entry.index.notam_id.replace('/', '_')))!.xml);
    } });
  try {
    await service.restore(); await service.refresh();
    // The preceding implementation deferred both members of the two-entry case
    // here, then expired during the second successful detail response next round.
    now = service.read()!.notices[0]!.detailCheckedAt! + 10 * 60_000 + 28_000;
    reads.clear(); await service.refresh();
    slow = true;
    for (let round = 0; round < 6; round++) {
      now = service.status.nextAttemptAt! + 30_000;
      reads.clear(); check(); await service.refresh(); check();
      assert.equal(service.read()!.error, undefined);
      assert.equal(service.read()!.notices.length, count);
    }
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('validated index membership publishes before detail work, and each verified detail publishes independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-detail-publication-')), entries = fixtures(3);
  let now = START, changed = false, observed = false;
  let service: ReturnType<typeof createTfrService>;
  const options = { directory, signal: new AbortController().signal, now: () => now,
    wait: async (ms: number) => { now += ms; }, fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('getTfrList')) return Response.json(changed ? [
        { ...entries[1]!.index, mod_abs_time: '202610052101' }, entries[0]!.index,
      ] : entries.map(entry => entry.index));
      const entry = entries.find(entry => url.includes(entry.index.notam_id.replace('/', '_')))!;
      if (changed && entry === entries[1]) {
        const during = service.read()!;
        assert.ok(during.checkedAt > START + 10 * 60_000, 'validated index check is already published');
        assert.equal(during.notices.length, 2, 'validated withdrawals do not wait for detail work');
        assert.equal(during.notices[0]!.areas[0]!.upper, '11000 ft MSL', 'successful recheck is already visible');
        assert.ok(during.notices[0]!.detailCheckedAt! > START + 10 * 60_000);
        assert.equal(during.notices[1]!.modifiedAt, Date.parse('2026-10-01T15:51Z'), 'unacquired revision stays private');
        assert.equal(during.issues?.[0]?.id, entries[1]!.index.notam_id, 'unacquired revision remains explicit');
        const stored = JSON.parse(JSON.parse(await readFile(`${directory}/tfrs/snapshot.json`, 'utf8')).data);
        assert.deepEqual(stored.notices, during.notices, 'publication requires a durable snapshot');
        observed = true;
        return new Response(null, { status: 502 });
      }
      return new Response(changed ? entry.xml.replaceAll('10000', '11000') : entry.xml);
    } };
  service = createTfrService(options);
  try {
    await service.restore(); await service.refresh();
    const before = service.read()!;
    assert.equal(service.read(), before, 'unchanged reads preserve publication identity for HTTP caching');
    now += 12 * 60_000; changed = true; await service.refresh();
    assert.ok(observed);
    const after = service.read()!;
    assert.equal(after.notices.length, 2);
    assert.equal(after.issues?.[0]?.retainedCheckedAt, before.notices[1]!.detailCheckedAt);
    assert.equal(after.error, 'incomplete-details');
    await service.close(); service = createTfrService(options); await service.restore();
    assert.deepEqual(service.read(), after);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('national-size successful TFR rounds keep index and detail freshness through repeated cycles and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-national-clock-')), entries = fixtures(90);
  let now = START, checkPublished = false, maximumIndexAge = 0, calls = 0, lastIndexAt = 0;
  let service: ReturnType<typeof createTfrService>;
  const observe = () => {
    if (!checkPublished) return;
    const snapshot = service.read()!;
    maximumIndexAge = Math.max(maximumIndexAge, now - snapshot.checkedAt);
    assert.ok(now - snapshot.checkedAt < TFR_STALE_MS, `index overdue by normal work: ${now - snapshot.checkedAt}`);
    assert.ok(snapshot.notices.every(notice => now - notice.detailCheckedAt! < TFR_DETAIL_REFRESH_MS));
  };
  const options = { directory, signal: new AbortController().signal, now: () => now,
    wait: async (ms: number) => { now += ms; observe(); }, fetch: async (input: string | URL | Request) => {
      now += 200; observe(); calls++;
      const url = String(input);
      if (url.endsWith('getTfrList')) {
        assert.ok(now - lastIndexAt >= 3 * 60_000, 'detail-only rounds do not shorten the index cadence');
        lastIndexAt = now;
        return Response.json(entries.map(entry => entry.index));
      }
      return new Response(entries.find(entry => url.includes(entry.index.notam_id.replace('/', '_')))!.xml);
    } };
  service = createTfrService(options);
  try {
    await service.restore(); await service.refresh(); checkPublished = true;
    for (let round = 0; round < 6; round++) {
      if (round === 2) {
        await service.close(); service = createTfrService(options); await service.restore();
        const before = calls; await service.refresh(); assert.equal(calls, before, 'restart preserves admission');
      }
      now = service.status.nextAttemptAt! + 30_000;
      observe(); await service.refresh(); observe();
      assert.equal(service.read()!.error, undefined); assert.deepEqual(service.read()!.issues, []);
      assert.equal(service.read()!.notices.length, 90);
    }
    assert.ok(maximumIndexAge > 3 * 60_000, 'exercise scheduler delay and restart cooldown');
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('slow detail queues interleave validated index checks and withdraw absent members without fetching their details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-interleaved-index-')), entries = fixtures(16);
  let now = START, slow = false, indexes = 0;
  const detailReads: string[] = [];
  const service = createTfrService({ directory, signal: new AbortController().signal, now: () => now,
    wait: async ms => { now += ms; }, fetch: async input => {
      if (slow) now += 29_999;
      const url = String(input);
      if (url.endsWith('getTfrList')) { indexes++; return Response.json((indexes > 2 ? entries.slice(0, 8) : entries).map(e => e.index)); }
      const entry = entries.find(e => url.includes(e.index.notam_id.replace('/', '_')))!;
      detailReads.push(entry.index.notam_id);
      assert.ok(now - service.read()!.checkedAt < TFR_STALE_MS, 'detail work cannot monopolize index checks');
      return new Response(entry.xml);
    } });
  try {
    await service.restore(); await service.refresh();
    slow = true; detailReads.length = 0; now = service.status.nextAttemptAt!;
    await service.refresh();
    assert.ok(indexes >= 3); assert.equal(service.read()!.notices.length, 8);
    assert.ok(detailReads.every(id => entries.slice(0, 8).some(e => e.index.notam_id === id)));
    assert.equal(service.read()!.error, undefined);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('work exceeding serial capacity keeps index membership fresh without pretending old detail is current', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-over-capacity-')), entries = fixtures(90);
  let now = START, details = 0;
  const service = createTfrService({ directory, signal: new AbortController().signal, now: () => now,
    wait: async ms => { now += ms; }, fetch: async input => {
      now += 29_999;
      const url = String(input);
      if (url.endsWith('getTfrList')) return Response.json(entries.map(entry => entry.index));
      details++;
      return new Response(entries.find(entry => url.includes(entry.index.notam_id.replace('/', '_')))!.xml);
    } });
  try {
    await service.restore(); await service.refresh();
    const snapshot = service.read()!;
    assert.equal(details, 90, 'each revision is attempted only once per round, even under overload');
    assert.ok(now - snapshot.checkedAt < TFR_STALE_MS);
    assert.ok(snapshot.notices.some(notice => now - notice.detailCheckedAt! >= TFR_DETAIL_REFRESH_MS));
    assert.equal(snapshot.error, 'detail-recheck-due');
    assert.equal(service.status.error, 'detail-recheck-due');
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a failed early recheck remains unresolved when a smaller index makes its detail otherwise reusable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-early-failure-')), entries = fixtures(16);
  let now = START, failing = false, withdrawn = false, attempts = 0;
  const options = { directory, signal: new AbortController().signal, now: () => now,
    wait: async (ms: number) => { now += ms; }, fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('getTfrList')) return Response.json((withdrawn ? entries.slice(0, 1) : entries).map(entry => entry.index));
      const entry = entries.find(entry => url.includes(entry.index.notam_id.replace('/', '_')))!;
      if (entry === entries[0]) { attempts++; if (failing) return new Response(null, { status: 502 }); }
      return new Response(entry.xml);
    } };
  let service = createTfrService(options);
  try {
    await service.restore(); await service.refresh();
    const original = service.read()!.notices[0]!;
    now += 6 * 60_000; failing = true; await service.refresh();
    assert.equal(service.read()!.issues?.[0]?.id, original.id);
    assert.equal(attempts, 2, 'queue pressure brings this recheck forward');
    await service.close(); service = createTfrService(options); await service.restore();
    withdrawn = true; now = service.status.nextAttemptAt!; await service.refresh();
    assert.ok(now - original.detailCheckedAt! < 10 * 60_000, 'the retained detail is still younger than a solitary refresh deadline');
    assert.equal(attempts, 3, 'index shrinkage must not erase a failed recheck');
    assert.equal(service.read()!.issues?.[0]?.retainedCheckedAt, original.detailCheckedAt);
    assert.equal(service.read()!.error, 'incomplete-details');
    failing = false; now = service.status.nextAttemptAt!; await service.refresh();
    assert.equal(attempts, 4); assert.equal(service.read()!.error, undefined);
    assert.deepEqual(service.read()!.issues, []);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
