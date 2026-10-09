import { createHash } from 'node:crypto';
import { mkdir, open, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { isRecord, isTfrSnapshot, TFR_MAX_BYTES, TFR_REFRESH_MS, TFR_DETAIL_REFRESH_MS, type TfrSnapshot, type TfrNotice, type TfrSourceIssue } from '@zlayer/contracts';
import { atomicStateFile } from '../state-file';
import { acquireNotamLock } from './lock';
import { parseTfrDetail, parseTfrIndex } from './tfr-normalize';
import { retryAfterAt } from '../retry-after';
import { tfrDetailFresh } from '../../../src/layers/notams/tfr-time';

const REQUEST_TIMEOUT_MS = 30_000, REQUEST_SPACING_MS = 1000;
const REQUEST_SLOT_MS = REQUEST_TIMEOUT_MS + REQUEST_SPACING_MS;
// A deferred queue cannot start before admission, the scheduler tick and the
// next index download. Every detail ahead of it consumes a separate request slot.
const NEXT_ROUND_MS = TFR_REFRESH_MS + 30_000 + REQUEST_SLOT_MS;
// Include index requests interleaved with a worst-case serial detail queue.
const queueTime = (count: number) => count * REQUEST_SLOT_MS +
  Math.ceil(count * REQUEST_SLOT_MS / (TFR_REFRESH_MS - REQUEST_SLOT_MS)) * REQUEST_SLOT_MS;
const INDEX = 'https://tfr.faa.gov/tfrapi/getTfrList';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
type Budget = { schemaVersion: 1; source: 'FAA-TFR'; nextAt: number; backoffAt: number; failed: boolean };
const instant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 8.64e15;
/** One durable background owner. HTTP readers never cause upstream work. */
export function createTfrService(options: { directory: string; signal: AbortSignal; fetch?: typeof fetch;
  now?: () => number; wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  userAgent?: string; log?: (message: string) => void }) {
  const now = options.now ?? Date.now, fetcher = options.fetch ?? fetch;
  const lifetime = new AbortController(), signal = AbortSignal.any([options.signal, lifetime.signal]);
  const directory = join(options.directory, 'tfrs'), file = join(directory, 'snapshot.json');
  let lock: Awaited<ReturnType<typeof acquireNotamLock>> | undefined, budget: Budget | undefined;
  let snapshot: TfrSnapshot | undefined, error: string | undefined, requestAt = 0;
  // Index admission and detail work have different clocks. The persisted budget
  // remains a conservative restart barrier; a running owner polls the index on
  // its own deadline, including while a large detail queue is being acquired.
  let nextIndexAt = 0, nextDetailAt = Infinity, admissionAt = 0;
  let index: ReturnType<typeof parseTfrIndex> = [];
  let view: { published: TfrSnapshot; value: TfrSnapshot } | undefined;
  let pending: Promise<void> | undefined, restoring: Promise<void> | undefined;
  let restored = false, stopped = false;
  const details = new Map<string, TfrNotice>();
  function held() { signal.throwIfAborted(); if (!lock || stopped) throw new Error('TFR collector unavailable'); lock.assertHeld(); }
  async function saveBudget(value: Budget) {
    try {
      held(); await atomicStateFile(join(directory, 'admission.json'), JSON.stringify({ ...value, sha256: digest(JSON.stringify(value)) }));
      held(); budget = value;
    } catch (cause) { budget = undefined; throw cause; }
  }
  async function savedSnapshot(path: string): Promise<TfrSnapshot> {
    const handle = await open(path, 'r');
    try {
      if ((await handle.stat()).size > TFR_MAX_BYTES * 2 + 1024) throw new Error('TFR cache size');
      const saved: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!isRecord(saved) || typeof saved.data !== 'string' || Buffer.byteLength(saved.data) > TFR_MAX_BYTES || digest(saved.data) !== saved.sha256) throw new Error('TFR cache checksum');
      const value: unknown = JSON.parse(saved.data);
      if (!isTfrSnapshot(value) || value.checkedAt > now() + 30_000 ||
        value.notices.some(n => n.detailCheckedAt !== undefined && n.detailCheckedAt > now() + 30_000) ||
        [...value.notices, ...(value.issues ?? [])].some(n => n.modifiedAt > value.checkedAt + 60_000)) throw new Error('TFR cache invalid');
      return value;
    } finally { await handle.close(); }
  }
  async function saveSnapshot(path: string, value: TfrSnapshot) {
    held(); const data = JSON.stringify(value);
    if (!isTfrSnapshot(value) || Buffer.byteLength(data) > TFR_MAX_BYTES) throw new Error('TFR snapshot too large');
    await atomicStateFile(path, JSON.stringify({ sha256: digest(data), data })); held();
  }
  async function publish(checkedAt: number, members: typeof index, failures: ReadonlyMap<string, TfrSourceIssue>) {
    const previous = new Map(snapshot?.notices.map(notice => [notice.id, notice]));
    const notices: TfrNotice[] = [], issues: TfrSourceIssue[] = [];
    for (const entry of members) {
      const detail = details.get(entry.id), failure = failures.get(entry.id);
      if (!failure && detail?.modifiedAt === entry.modifiedAt) notices.push({ ...detail, ...entry });
      else {
        const retained = previous.get(entry.id);
        if (retained) notices.push(retained);
        issues.push({ ...entry, reason: failure?.reason ?? 'detail-unavailable', retainedCheckedAt: retained?.detailCheckedAt ?? null });
      }
    }
    notices.sort((a, b) => a.id.localeCompare(b.id));
    const candidate: TfrSnapshot = { schemaVersion: 1, source: 'FAA-TFR', checkedAt, notices, issues,
      ...(issues.length ? { error: 'incomplete-details' } : {}) };
    await saveSnapshot(file, candidate);
    snapshot = candidate;
  }
  function restore(): Promise<void> {
    return restoring ??= (async () => {
      try { snapshot = await savedSnapshot(file); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') error = 'saved-data-invalid'; }
      for (const notice of snapshot?.notices ?? []) details.set(notice.id, notice);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        lock = await acquireNotamLock(join(directory, 'writer.lock')); held();
        let provisioned = true;
        try { await stat(join(directory, 'provisioned')); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; provisioned = false; }
        if (!provisioned) {
          // Provision before granting allowance. A torn initial write fails closed.
          let prior = false;
          try { await stat(join(directory, 'admission.json')); prior = true; }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
          await atomicStateFile(join(directory, 'provisioned'), 'FAA-TFR');
          if (prior) throw new Error('TFR admission recovery required');
          await saveBudget({ schemaVersion: 1, source: 'FAA-TFR', nextAt: snapshot ? now() + TFR_REFRESH_MS : 0, backoffAt: 0, failed: false });
        } else {
          const handle = await open(join(directory, 'admission.json'), 'r');
          try {
            if ((await handle.stat()).size > 16 * 1024) throw new Error('TFR admission size');
            const value: unknown = JSON.parse(await handle.readFile('utf8'));
            if (!isRecord(value) || value.schemaVersion !== 1 || value.source !== 'FAA-TFR' || !instant(value.nextAt) || !instant(value.backoffAt) || typeof value.failed !== 'boolean') throw new Error('TFR admission invalid');
            const { sha256, ...content } = value;
            if (sha256 !== digest(JSON.stringify(content))) throw new Error('TFR admission checksum');
            budget = content as Budget;
          } finally { await handle.close(); }
        }
        nextIndexAt = Math.max(budget!.nextAt, (snapshot?.checkedAt ?? -TFR_REFRESH_MS) + TFR_REFRESH_MS);
        admissionAt = budget!.nextAt;
        if (budget?.failed) error = 'refresh-failed';
        try {
          const partial = await savedSnapshot(join(directory, 'details.json'));
          for (const notice of partial.notices) {
            const published = details.get(notice.id);
            if (!published || notice.modifiedAt > published.modifiedAt || notice.modifiedAt === published.modifiedAt &&
              (notice.detailCheckedAt ?? 0) > (published.detailCheckedAt ?? 0)) details.set(notice.id, notice);
          }
        } catch { /* Optional progress cache cannot reset admission or discredit published data. */ }
        restored = true;
      } catch {
        budget = undefined; error = 'storage-unavailable'; await lock?.release(); lock = undefined;
      }
    })();
  }
  async function download(url: string, maxBytes: number): Promise<{ text: string; checkedAt: number }> {
    held(); if (!budget || now() < budget.backoffAt) throw new Error('TFR source backing off');
    const spacing = requestAt - now();
    if (spacing > 0) await (options.wait ? options.wait(spacing, signal) : delay(spacing, undefined, { signal }));
    held();
    const started = now(), dispatchBy = started + REQUEST_TIMEOUT_MS;
    await saveBudget({ ...budget!, failed: true, nextAt: dispatchBy + TFR_REFRESH_MS });
    held(); if (now() > dispatchBy) throw new Error('TFR reservation expired');
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let response: Response | undefined;
    try {
      response = await fetcher(url, { signal: requestSignal, redirect: 'error', headers: {
        Accept: 'application/json, application/xml, text/xml', 'Cache-Control': 'no-cache',
        'User-Agent': options.userAgent ?? 'ZLayer-info-server/0.1' } });
      if (response.status === 429 || response.status === 503) {
        const time = now();
        const backoffAt = Math.max(time + 300_000, retryAfterAt(response.headers.get('retry-after'), time) ?? 0);
        await saveBudget({ ...budget!, backoffAt: Math.max(budget!.backoffAt, backoffAt) });
        throw new Error('TFR source backing off');
      }
      if (!response.ok || !response.body) throw new Error('TFR source unavailable');
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('TFR source too large');
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.length; if (bytes > maxBytes) throw new Error('TFR source too large');
        chunks.push(chunk);
      }
      requestSignal.throwIfAborted();
      if (!response.headers.get('content-encoding') && length !== null && Number(length) !== bytes) throw new Error('TFR source truncated');
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), checkedAt: started };
    } finally {
      await response?.body?.cancel().catch(() => {});
      requestAt = Math.max(started, now()) + REQUEST_SPACING_MS;
      // During shutdown retain the already durable conservative crash margin.
      if (!signal.aborted && budget) await saveBudget({ ...budget, nextAt: Math.max(started, now()) + TFR_REFRESH_MS });
    }
  }
  async function checkIndex(failures: Map<string, TfrSourceIssue>) {
    const input = await download(INDEX, 1024 * 1024), checkedAt = input.checkedAt;
    const members = parseTfrIndex(JSON.parse(input.text));
    if (members.some(n => n.modifiedAt > checkedAt + 60_000)) throw new Error('TFR index from future');
    // A regressed index cannot establish either current detail or withdrawals.
    // Include unresolved revisions and private progress in the high-water mark.
    const published = new Map(snapshot?.notices.map(n => [n.id, n]));
    const revisions = new Map(snapshot?.issues?.map(issue => [issue.id, issue.modifiedAt]));
    if (members.some(n => n.modifiedAt < Math.max(details.get(n.id)?.modifiedAt ?? 0, published.get(n.id)?.modifiedAt ?? 0, revisions.get(n.id) ?? 0))) {
      throw new Error('TFR index regressed');
    }
    // A complete validated index establishes membership immediately. Missing or
    // changed details remain explicit uncertainty until acquired; successful
    // detail work cannot postpone withdrawals or the index's freshness clock.
    await publish(checkedAt, members, failures);
    index = members;
    nextIndexAt = checkedAt + TFR_REFRESH_MS;
    error = undefined;
    const present = new Set(members.map(n => n.id));
    for (const id of details.keys()) if (!present.has(id)) details.delete(id);
    for (const id of failures.keys()) if (!present.has(id)) failures.delete(id);
  }
  async function collect() {
    const failures = new Map(snapshot?.issues?.map(issue => [issue.id, issue]));
    if (!index.length || now() >= nextIndexAt) await checkIndex(failures);
    const attempted = new Set<string>();
    // Plan the deferred queue against every expiry, not just the first one.
    // Bringing its oldest member forward also spreads a cluster of deadlines.
    // Required acquisitions consume time before the next admitted round too.
    // Replan after each request; never retry a member inside the same round.
    for (;;) {
      held();
      if (now() >= nextIndexAt) await checkIndex(failures);
      const time = now();
      const waiting = index.filter(entry => !attempted.has(`${entry.id}:${entry.modifiedAt}`));
      const unresolved = new Set(snapshot?.issues?.map(issue => issue.id));
      const required = waiting.filter(entry => {
        const saved = details.get(entry.id);
        return unresolved.has(entry.id) || saved?.modifiedAt !== entry.modifiedAt || !tfrDetailFresh(saved, time);
      });
      const requiredIds = new Set(required.map(entry => entry.id));
      const reusable = waiting.filter(entry => !requiredIds.has(entry.id)).sort((a, b) =>
        details.get(a.id)!.detailCheckedAt! - details.get(b.id)!.detailCheckedAt! || a.id.localeCompare(b.id));
      const bringForward = reusable.some((entry, position) =>
        details.get(entry.id)!.detailCheckedAt! + TFR_DETAIL_REFRESH_MS <=
          time + NEXT_ROUND_MS + queueTime(required.length + position + 1));
      const entry = bringForward ? reusable[0] : required[0];
      if (!entry) break;
      attempted.add(`${entry.id}:${entry.modifiedAt}`);
      let record: TfrNotice, reason: TfrSourceIssue['reason'] = 'detail-unavailable';
      try {
        const detail = await download(`https://tfr.faa.gov/download/detail_${entry.id.replace('/', '_')}.xml`, 2 * 1024 * 1024);
        reason = 'detail-invalid'; record = { ...parseTfrDetail(detail.text, entry), detailCheckedAt: detail.checkedAt };
      } catch (cause) {
        // Cancellation, lost ownership and uncertain admission writes still abort
        // publication. A source/detail failure qualifies only this index member.
        held(); if (!budget) throw cause;
        failures.set(entry.id, { ...entry, reason,
          retainedCheckedAt: snapshot?.notices.find(notice => notice.id === entry.id)?.detailCheckedAt ?? null });
        await publish(snapshot!.checkedAt, index, failures);
        continue;
      }
      // The private cache preserves completed work after another detail fails;
      // only the completed index membership becomes a national HTTP result.
      await saveSnapshot(join(directory, 'details.json'),
        { schemaVersion: 1, source: 'FAA-TFR', checkedAt: snapshot!.checkedAt, notices: [...details.values()].filter(n => n.id !== entry.id).concat(record) });
      details.set(entry.id, record);
      failures.delete(entry.id);
      await publish(snapshot!.checkedAt, index, failures);
    }
    // A completed round can replace its provisional crash margin with the next
    // index admission. Restart must not add a second interval after detail work.
    // In-flight, failed or interrupted writes retain their conservative margin.
    await saveBudget({ ...budget!, failed: false, nextAt: Math.max(nextIndexAt, requestAt) });
    // A healthy detail queue may need another round before the next index poll.
    // Plan its earliest deadline against the whole queue plus one scheduler tick.
    // Failed members retry on index cadence, never in a tight detail-only loop.
    const deadlines = snapshot?.issues?.length ? [] : [...details.values()]
      .map(notice => (notice.detailCheckedAt ?? 0) + TFR_DETAIL_REFRESH_MS).sort((a, b) => a - b);
    nextDetailAt = deadlines.length ? Math.max(now(), Math.min(...deadlines.map((deadline, position) =>
      deadline - 30_000 - queueTime(position + 1)))) : Infinity;
  }
  const nextAttempt = () => Math.max(admissionAt, budget?.backoffAt ?? 0, Math.min(nextIndexAt, nextDetailAt));
  function refresh(): Promise<void> {
    if (pending) return pending;
    if (!restored || !budget || stopped || signal.aborted || now() < nextAttempt()) return Promise.resolve();
    pending = collect().catch(() => {
      if (signal.aborted) return;
      nextIndexAt = Math.max(nextIndexAt, budget?.nextAt ?? now() + TFR_REFRESH_MS);
      admissionAt = nextIndexAt;
      nextDetailAt = Infinity;
      error = 'refresh-failed'; options.log?.('TFR refresh failed; retaining published snapshot');
    }).finally(() => { pending = undefined; });
    return pending;
  }
  const sourceError = () => error ?? snapshot?.error ??
    (snapshot?.notices.some(notice => !tfrDetailFresh(notice, now())) ? 'detail-recheck-due' : undefined);
  return { restore, refresh,
    close: async () => { stopped = true; lifetime.abort(); await restoring; await pending; await lock?.release(); lock = undefined; },
    read: (): TfrSnapshot | undefined => {
      if (!snapshot) return;
      const error = sourceError();
      // Stable identity covers detail publications as well as index/error changes.
      // HTTP encoding must not use the independently advancing index time as a
      // content revision, or it will keep serving superseded XML evidence.
      if (view?.published !== snapshot || view.value.error !== error) {
        view = { published: snapshot, value: { ...snapshot, ...(error ? { error } : {}) } };
      }
      return view.value;
    },
    get status() { return { ready: !!snapshot, checkedAt: snapshot?.checkedAt ?? null, loading: !!pending, error: sourceError() ?? null, unresolvedRecords: snapshot?.issues?.length ?? 0,
      nextAttemptAt: budget ? nextAttempt() : null }; } };
}
