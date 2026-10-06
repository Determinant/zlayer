import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TFR_DETAIL_REFRESH_MS, TFR_REFRESH_MS } from '@zlayer/contracts';
import { createTfrService } from '../tools/info-server/notams/tfr-service';
import corpus from './fixtures/tfrs.json' with { type: 'json' };

const START = Date.parse('2026-10-05T21:00Z');
const index = corpus.cases.slice(0, 2).map(c => c.index);

for (const unresolved of [false, true]) test(`regressed TFR indexes preserve ${unresolved ? 'unresolved' : 'published'} revisions and membership across restart`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-rollback-'));
  let now = START, revision = '202610052000', omitOther = false, failed = unresolved, detailReads = 0;
  const options = { directory, now: () => now, wait: async (ms: number) => { now += ms; }, signal: new AbortController().signal,
    fetch: async (input: string | URL | Request) => {
      if (String(input).endsWith('getTfrList')) return Response.json([
        { ...index[0], mod_abs_time: revision }, ...(omitOther ? [] : [index[1]]),
      ]);
      detailReads++;
      const first = String(input).includes(index[0]!.notam_id.replace('/', '_'));
      if (first && failed) return new Response(null, { status: 502 });
      return new Response(first ? corpus.cases[0]!.xml.replaceAll('10000', revision === '202610052000' ? '11000' : '10000') : corpus.cases[1]!.xml);
    } };
  let service = createTfrService(options);
  try {
    await service.restore(); await service.refresh();
    const original = service.read()!, reads = detailReads;
    revision = '202610051900'; omitOther = true; failed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      now += TFR_REFRESH_MS; await service.refresh();
      assert.equal(service.read()!.checkedAt, original.checkedAt, 'an older index cannot advance source freshness');
      assert.deepEqual(service.read()!.notices, original.notices, 'an older index cannot revise or withdraw published notices');
      assert.deepEqual(service.read()!.issues, original.issues, 'unresolved newer revisions survive repeated regressions');
      assert.equal(service.read()!.error, 'refresh-failed');
      assert.equal(detailReads, reads, 'reject before acquiring obsolete detail');
      await service.close(); service = createTfrService(options); await service.restore();
    }
    revision = '202610052000'; omitOther = false; now += TFR_REFRESH_MS; await service.refresh();
    assert.equal(service.read()!.error, undefined);
    assert.equal(service.read()!.notices.find(n => n.id === index[0]!.notam_id)!.areas[0]!.upper, '11000 ft MSL');
    assert.equal(service.read()!.notices.length, 2);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an interrupted TFR withdrawal cannot erase the published revision guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-interrupted-withdrawal-'));
  let now = START, revision = '202610052000', withdraw = false;
  const service = createTfrService({ directory, now: () => now, wait: async ms => { now += ms; }, signal: new AbortController().signal,
    fetch: async input => String(input).endsWith('getTfrList')
      ? Response.json(withdraw ? [] : [{ ...index[0], mod_abs_time: revision }]) : new Response(corpus.cases[0]!.xml) });
  try {
    await service.restore(); await service.refresh();
    const original = service.read()!, file = join(directory, 'tfrs', 'snapshot.json'), saved = await readFile(file);
    await rm(file); await mkdir(file); withdraw = true; now += TFR_REFRESH_MS; await service.refresh();
    assert.equal(service.read()!.checkedAt, original.checkedAt);
    await rm(file, { recursive: true }); await writeFile(file, saved);
    withdraw = false; revision = '202610051900'; now += TFR_REFRESH_MS; await service.refresh();
    assert.equal(service.read()!.checkedAt, original.checkedAt);
    assert.deepEqual(service.read()!.notices, original.notices);
    assert.equal(service.read()!.error, 'refresh-failed');
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unchanged TFR index metadata cannot indefinitely cache XML or renew its age, including across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-revalidation-'));
  let now = START, revised = false, failed = false;
  const detailTimes: number[] = [];
  const options = { directory, now: () => now, wait: async (ms: number) => { now += ms; }, signal: new AbortController().signal,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('Cache-Control'), 'no-cache');
      if (String(input).endsWith('getTfrList')) return Response.json([index[0]]);
      detailTimes.push(now);
      return failed ? new Response(null, { status: 502 }) : new Response(revised
        ? corpus.cases[0]!.xml.replaceAll('10000', '11000') : corpus.cases[0]!.xml);
    } };
  let service = createTfrService(options);
  try {
    await service.restore(); await service.refresh();
    const original = service.read()!.notices[0]!;
    assert.equal(original.detailCheckedAt, detailTimes[0]);
    revised = true;
    for (let i = 0; i < 3; i++) {
      now += TFR_REFRESH_MS; await service.refresh();
      assert.deepEqual(service.read()!.notices[0], original);
      assert.ok(service.read()!.checkedAt > original.detailCheckedAt!);
    }
    await service.close(); service = createTfrService(options); await service.restore();
    now += TFR_REFRESH_MS; await service.refresh();
    assert.equal(detailTimes.length, 1);
    now = original.detailCheckedAt! + TFR_DETAIL_REFRESH_MS;
    assert.equal(service.read()!.error, 'detail-recheck-due', 'qualification changes even before the next collector round');
    now += TFR_REFRESH_MS; await service.refresh();
    const current = service.read()!.notices[0]!;
    assert.equal(detailTimes.length, 2);
    assert.equal(current.modifiedAt, original.modifiedAt);
    assert.equal(current.detailCheckedAt, detailTimes[1]);
    assert.equal(current.areas[0]!.upper, '11000 ft MSL');
    assert.equal(service.read()!.error, undefined);
    // An old progress file must not overwrite a newer published detail at the same index revision.
    const data = JSON.stringify({ schemaVersion: 1, source: 'FAA-TFR', checkedAt: START, notices: [original] });
    await writeFile(join(directory, 'tfrs', 'details.json'), JSON.stringify({ data, sha256: createHash('sha256').update(data).digest('hex') }));
    await service.close(); service = createTfrService(options); await service.restore();
    now += TFR_REFRESH_MS; await service.refresh();
    assert.deepEqual(service.read()!.notices[0], current); assert.equal(detailTimes.length, 2);
    failed = true; now += TFR_DETAIL_REFRESH_MS; await service.refresh();
    const saved = service.read()!;
    assert.deepEqual(saved.notices[0], current);
    assert.equal(saved.issues![0]!.modifiedAt, current.modifiedAt);
    assert.equal(saved.issues![0]!.retainedCheckedAt, current.detailCheckedAt);
    assert.equal(saved.error, 'incomplete-details');
    await service.close(); service = createTfrService(options); await service.restore();
    assert.deepEqual(service.read(), saved);
    failed = false; now += TFR_REFRESH_MS; await service.refresh();
    assert.deepEqual(service.read()!.issues, []); assert.equal(service.read()!.error, undefined);
    assert.equal(service.read()!.notices[0]!.detailCheckedAt, detailTimes.at(-1));
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('legacy TFR caches retain unknown detail age until the XML is acquired again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-legacy-age-'));
  let now = START, details = 0;
  const options = { directory, now: () => now, wait: async (ms: number) => { now += ms; }, signal: new AbortController().signal,
    fetch: async (input: string | URL | Request) => {
      if (String(input).endsWith('getTfrList')) return Response.json([index[0]]);
      details++; return new Response(corpus.cases[0]!.xml);
    } };
  let service = createTfrService(options);
  try {
    await service.restore(); await service.refresh(); await service.close();
    for (const name of ['snapshot.json', 'details.json']) {
      const path = join(directory, 'tfrs', name), envelope = JSON.parse(await readFile(path, 'utf8'));
      const saved = JSON.parse(envelope.data); delete saved.notices[0].detailCheckedAt;
      const data = JSON.stringify(saved);
      await writeFile(path, JSON.stringify({ data, sha256: createHash('sha256').update(data).digest('hex') }));
    }
    service = createTfrService(options); await service.restore();
    assert.equal(service.read()!.error, 'detail-recheck-due');
    assert.equal(service.read()!.notices[0]!.detailCheckedAt, undefined);
    now += TFR_REFRESH_MS; await service.refresh();
    assert.equal(details, 2); assert.equal(service.read()!.error, undefined);
    assert.ok(service.read()!.notices[0]!.detailCheckedAt! > START);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

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

test('TFR failed details remain explicit through restart without redownloading completed details', async () => {
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
    await service.restore(); await service.refresh();
    assert.equal(service.read()!.notices.length, 1);
    assert.equal(service.read()!.error, 'incomplete-details');
    assert.equal(service.read()!.issues![0]!.id, index[1]!.notam_id);
    assert.equal(service.read()!.issues![0]!.retainedCheckedAt, null);
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

test('one invalid TFR detail cannot freeze healthy updates or withdrawals, and retained evidence never gains a new check time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-isolation-'));
  let now = START, currentIndex = index, invalid = false;
  const calls: string[] = [];
  const options = { directory, now: () => now, wait: async (ms: number) => { now += ms; }, signal: new AbortController().signal,
    fetch: async (input: string | URL | Request) => {
      const url = String(input); calls.push(url);
      if (url.endsWith('getTfrList')) return Response.json(currentIndex);
      const c = corpus.cases.find(c => url.includes(c.index.notam_id.replace('/', '_')))!;
      return new Response(invalid && c === corpus.cases[0] ? '<unrecognized/>' : c.xml);
    } };
  let service = createTfrService(options);
  try {
    await service.restore(); await service.refresh();
    const original = service.read()!, retained = original.notices.find(n => n.id === index[0]!.notam_id)!;
    const changed = { ...index[0]!, mod_abs_time: '202610052101' };
    currentIndex = [changed, corpus.cases[2]!.index]; invalid = true; now += 180_000;
    await service.refresh();
    let saved = service.read()!;
    assert.ok(saved.checkedAt > original.checkedAt);
    assert.equal(saved.error, 'incomplete-details');
    assert.deepEqual(saved.notices.find(n => n.id === retained.id), retained);
    assert.equal(saved.notices.some(n => n.id === index[1]!.notam_id), false, 'validated index absence withdraws unrelated notices');
    assert.equal(saved.notices.some(n => n.id === currentIndex[1]!.notam_id), true, 'healthy later details publish despite the earlier failure');
    assert.equal(saved.issues![0]!.retainedCheckedAt, retained.detailCheckedAt);
    assert.equal(saved.issues![0]!.reason, 'detail-invalid');
    await service.close(); service = createTfrService(options); await service.restore();
    assert.deepEqual(service.read(), saved);
    now += 180_000; await service.refresh(); saved = service.read()!;
    assert.equal(saved.issues![0]!.retainedCheckedAt, retained.detailCheckedAt, 'repeated failure cannot freshen old evidence');
    assert.equal(calls.filter(url => url.includes(corpus.cases[2]!.index.notam_id.replace('/', '_'))).length, 1);
    invalid = false; now += 180_000; await service.refresh();
    assert.deepEqual(service.read()!.issues, []); assert.equal(service.read()!.error, undefined);
    assert.equal(service.read()!.notices.find(n => n.id === retained.id)!.modifiedAt, Date.parse('2026-10-05T21:01Z'));
    const complete = service.read();
    currentIndex = [changed, changed]; now += 180_000; await service.refresh();
    assert.equal(service.read()!.checkedAt, complete!.checkedAt, 'malformed index cannot establish membership or advance time');
    assert.deepEqual(service.read()!.notices, complete!.notices);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('TFR detail overload accounts for remaining index members without violating durable source backoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tfr-detail-backoff-')); let now = START, calls = 0;
  const options = { directory, now: () => now, wait: async (ms: number) => { now += ms; }, signal: new AbortController().signal,
    fetch: async (input: string | URL | Request) => {
      calls++;
      return String(input).endsWith('getTfrList') ? Response.json(index)
        : new Response(null, { status: 429, headers: { 'Retry-After': '3600' } });
    } };
  let service = createTfrService(options);
  try {
    await service.restore(); await service.refresh();
    const saved = service.read()!;
    assert.equal(calls, 2); assert.deepEqual(saved.notices, []);
    assert.equal(saved.issues!.length, 2); assert.ok(saved.issues!.every(issue => issue.retainedCheckedAt === null));
    const nextAttemptAt = service.status.nextAttemptAt;
    await service.close(); now += 180_000; service = createTfrService(options);
    await service.restore(); await service.refresh();
    assert.equal(calls, 2); assert.equal(service.status.nextAttemptAt, nextAttemptAt);
    assert.deepEqual(service.read(), saved);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const failure of ['admission.json', 'details.json', 'cancel'] as const) {
  test(`TFR detail isolation cannot swallow ${failure} failure and publish a new snapshot`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tfr-publication-')), parent = new AbortController();
    let now = START, failing = false, calls = 0;
    const service = createTfrService({ directory, now: () => now, signal: parent.signal,
      wait: async ms => { now += ms; }, fetch: async input => {
        calls++;
        if (String(input).endsWith('getTfrList')) return Response.json(failing
          ? index.map(entry => ({ ...entry, mod_abs_time: '202610052101' })) : index);
        if (failing) {
          if (failure === 'cancel') parent.abort();
          else {
            const path = join(directory, 'tfrs', failure);
            await rm(path); await mkdir(path); // Force atomic replacement to fail.
          }
        }
        return new Response(corpus.cases.find(c => String(input).includes(c.index.notam_id.replace('/', '_')))!.xml);
      } });
    try {
      await service.restore(); await service.refresh();
      const before = service.read()!, published = await readFile(join(directory, 'tfrs', 'snapshot.json'), 'utf8');
      failing = true; now += 180_000; await service.refresh();
      assert.equal(calls, 5, 'unsafe round stops after the first detail');
      assert.equal(service.read()!.checkedAt, before.checkedAt);
      assert.deepEqual(service.read()!.notices, before.notices);
      assert.deepEqual(service.read()!.issues, []);
      assert.equal(await readFile(join(directory, 'tfrs', 'snapshot.json'), 'utf8'), published);
      if (failure !== 'cancel') assert.equal(service.status.error, 'refresh-failed');
    } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
