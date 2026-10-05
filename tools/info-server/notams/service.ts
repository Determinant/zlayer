import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { isNotamRecord, NOTAM_AIRPORT_MAX_RECORDS, NOTAM_REFRESH_MS, NOTAM_STALE_MS,
  type NotamAirportQuery, type NotamAirportSnapshot, type NotamEnvironment, type NotamFeedStatus, type NotamRecord } from '@zlayer/contracts';
import { workerJob } from '../worker-job';
import { createNotamSource, type NotamCredentials } from './client';
import { NotamError, notamError } from './error';
import { NOTAM_DAY_MS, NotamStore, type NotamGeneration } from './store';
import { compareNotamRevision, mergeSameNotamRevision, NotamRevisionConflict } from './revision';

export type NotamOptions = { enabled: boolean; environment?: NotamEnvironment; directory: string;
  credentials?: NotamCredentials; configurationError?: boolean };
const OVERLAP_MS = 10 * 60_000;
export async function notamOptionsFromEnv(env: NodeJS.ProcessEnv): Promise<NotamOptions> {
  const directory = resolve(env.NOTAMS_STATE_DIR ?? '.cache/notams');
  if (env.NOTAMS_ENABLED !== 'true') return { enabled: false, directory };
  const environment = env.NOTAMS_ENVIRONMENT;
  if (environment !== 'staging' && environment !== 'production') return { enabled: true, directory, configurationError: true };
  try {
    if (!env.NOTAMS_CLIENT_ID_FILE || !env.NOTAMS_CLIENT_SECRET_FILE) throw new Error();
    const [clientId, clientSecret] = await Promise.all([
      readFile(env.NOTAMS_CLIENT_ID_FILE, 'utf8'), readFile(env.NOTAMS_CLIENT_SECRET_FILE, 'utf8'),
    ]);
    if (![clientId, clientSecret].every(s => s.trim() && s.length < 8192 && !/[\r\n]/.test(s.trim()))) throw new Error();
    return { enabled: true, environment, directory, credentials: { clientId: clientId.trim(), clientSecret: clientSecret.trim() } };
  } catch { return { enabled: true, environment, directory, configurationError: true }; }
}

export function mergeNotamRecords(previous: readonly NotamRecord[], updates: readonly NotamRecord[]): readonly NotamRecord[] {
  if (!updates.length) return previous;
  const records = new Map(previous.map(record => [record.id, record]));
  let changed = false;
  for (let next of updates) {
    if (next.lifecycle === 'unknown') throw new NotamError('unsupported-lifecycle');
    const old = records.get(next.id);
    if (old) {
      const order = compareNotamRevision(next, old);
      if (order < 0) continue;
      if (!order && next.revision !== old.revision) {
        next = mergeSameNotamRevision(old, next);
      }
      if (next.revision === old.revision) continue;
    }
    records.set(next.id, next); changed = true;
  }
  if (records.size > 150_000) throw new NotamError('record-limit');
  return changed ? [...records.values()].sort((a, b) => a.id.localeCompare(b.id)) : previous;
}

export function createNotamService(options: NotamOptions | undefined,
  dependencies: { signal: AbortSignal; fetch?: typeof fetch; now?: () => number; log?: (message: string) => void }) {
  const now = dependencies.now ?? Date.now, enabled = options?.enabled ?? false;
  const environment = options?.environment ?? null;
  const configurationValid = enabled && !!environment && !!options?.credentials && !options.configurationError;
  const store = configurationValid ? new NotamStore(join(options!.directory, environment!), environment!, now) : undefined;
  const source = store ? createNotamSource({ environment: environment!, credentials: options!.credentials!, store, ...dependencies }) : undefined;
  let current: NotamGeneration | undefined, candidate: NotamGeneration | undefined;
  let domestic = new Map<string, NotamRecord[]>(), icao = new Map<string, NotamRecord[]>();
  let error: string | null = enabled && !configurationValid ? 'configuration-error' : null;
  let initialized = false, restoring: Promise<void> | undefined, pending: Promise<void> | undefined, stopped = false;
  let retryAt = 0, recoveryAttempted = false;
  const validSignal = () => { dependencies.signal.throwIfAborted(); if (stopped) throw new NotamError('stopping'); };
  function index(generation: NotamGeneration) {
    if (current?.records === generation.records) { current = generation; return; }
    const byDomestic = new Map<string, NotamRecord[]>(), byIcao = new Map<string, NotamRecord[]>();
    for (const record of generation.records) {
      if (record.lifecycle === 'cancelled' || record.lifecycle === 'cancellation') continue;
      for (const [codes, map] of [[record.locations, byDomestic], [record.icaoLocations, byIcao]] as const) {
        for (const code of codes) { const group = map.get(code) ?? []; group.push(record); map.set(code, group); }
      }
    }
    domestic = byDomestic; icao = byIcao; current = generation;
  }
  function failure(cause: unknown) {
    error = notamError(cause); retryAt = Math.max(now() + NOTAM_REFRESH_MS, cause instanceof NotamError ? cause.retryAt ?? 0 : 0);
    dependencies.log?.(`NOTAM ${error}${cause instanceof NotamRevisionConflict ? ` id=${cause.next.id} fields=${cause.fields.join(',')}` : ''}`);
  }
  function status(): NotamFeedStatus {
    const fresh = current && now() >= current.checkedAt && now() - current.checkedAt < NOTAM_STALE_MS;
    const continuity = current?.complete && now() >= current.watermark && now() - current.watermark + OVERLAP_MS < NOTAM_DAY_MS ? 'complete' : 'incomplete';
    return { enabled, environment, state: !enabled ? 'disabled' : !configurationValid ? 'unavailable'
      : !initialized && !error ? 'loading' : !current ? 'unavailable' : error || !fresh || continuity !== 'complete' ? 'degraded' : 'ready',
      generation: current?.generation ?? null, checkedAt: current?.checkedAt ?? null, watermark: current?.watermark ?? null,
      fullSyncAt: current?.fullSyncAt ?? null, recordCount: current?.records.length ?? 0, continuity, error: current?.incompleteReason ?? error,
      nextAttemptAt: store && initialized ? Math.max(retryAt, store.nextDataAt, !current && !candidate ? store.nextBulkAt : 0) : null };
  }
  function restore(): Promise<void> {
    return restoring ??= (async () => {
      if (!store) { initialized = true; return; }
      try {
        const saved = await store.restore(); validSignal(); if (saved) index(saved);
        if (store.recoveryError) error = store.recoveryError;
        if (saved && !saved.complete) error = saved.incompleteReason ?? error ?? 'incomplete-checkpoint';
        try { candidate = await store.restoreCandidate(); }
        catch (cause) { failure(cause); await store.discardCandidate(); }
        initialized = true;
      } catch (cause) { failure(cause); await store.close(); }
    })();
  }
  async function acquire(kind: 'bulk' | 'delta', since?: number) {
    const path = join(store!.directory, `${randomUUID()}.source.tmp`), output = path.replace('.source.tmp', '.parsed.tmp');
    try {
      const { requestedAt } = await source!.download(kind, path, since);
      const module = new URL(`../notams-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);
      // The bundle emits workers alongside main.js, while this source lives in notams/.
      const worker = import.meta.url.endsWith('.ts') ? module : new URL('./notams-worker.js', import.meta.url);
      let summary: { snapshotAt: number; count: number; bytes: number };
      try { summary = await workerJob(worker, { path, output, kind, requestedAt }, dependencies.signal); }
      catch (cause) { throw new NotamError(cause instanceof Error && /^[a-z][a-z0-9-]{0,63}$/.test(cause.message) ? cause.message : 'parse-failed'); }
      validSignal();
      if (summary.snapshotAt > now() + 30_000 || summary.snapshotAt < now() - NOTAM_DAY_MS) throw new NotamError('invalid-source-boundary');
      const records: NotamRecord[] = [], seen = new Set<string>(), stream = createReadStream(output);
      try {
        for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
          validSignal(); const record: unknown = JSON.parse(line);
          if (!isNotamRecord(record) || record.updatedAt > now() + 30_000 || kind === 'bulk' && seen.has(record.id)) throw new NotamError('invalid-record');
          seen.add(record.id); records.push(record);
          if (records.length > summary.count) throw new NotamError('incomplete-collection');
        }
      } finally { stream.destroy(); }
      if (records.length !== summary.count) throw new NotamError('incomplete-collection');
      return { records, snapshotAt: summary.snapshotAt, requestedAt };
    } finally { await Promise.all([rm(path, { force: true }), rm(output, { force: true })]); }
  }
  const inDeltaWindow = (base: NotamGeneration) => base.watermark <= now() && base.watermark - OVERLAP_MS >= now() - NOTAM_DAY_MS;
  const liveCanDelta = () => current?.complete && inDeltaWindow(current);
  async function invalidate(cause: unknown) {
    if (!current) return;
    const reason = current.incompleteReason ?? notamError(cause);
    current = { ...current, complete: false, incompleteReason: reason };
    await store!.invalidate(reason);
  }
  async function discardCandidate() {
    candidate = undefined;
    await store!.discardCandidate();
  }
  async function applyDelta(base: NotamGeneration) {
    const delta = await acquire('delta', base.watermark - OVERLAP_MS); validSignal();
    if (current && delta.requestedAt < current.watermark) throw new NotamError('invalid-source-boundary');
    const merged = mergeNotamRecords(base.records, delta.records);
    const expired = (record: NotamRecord) => ['cancelled', 'cancellation'].includes(record.lifecycle) && record.updatedAt < now() - 2 * NOTAM_DAY_MS;
    const records = merged.some(expired) ? merged.filter(record => !expired(record)) : merged;
    const { incompleteReason: _reason, ...verified } = base;
    const next = await store!.publish({ ...verified, records, checkedAt: delta.requestedAt, watermark: delta.requestedAt,
      complete: true });
    validSignal(); index(next); candidate = undefined; error = null; recoveryAttempted = false;
  }
  async function round() {
    validSignal();
    if (candidate && !inDeltaWindow(candidate)) await discardCandidate();
    if (!candidate && current && !current.complete && !recoveryAttempted) {
      recoveryAttempted = true;
      const previous = await store!.restorePrevious(); validSignal();
      if (previous && inDeltaWindow(previous)) candidate = previous;
    }
    if (candidate) {
      try { await applyDelta(candidate); }
      catch (cause) {
        // A failed replacement does not discredit the live dataset. Its next
        // budgeted round continues live deltas, rather than retrying a bad bridge.
        if (liveCanDelta()) await discardCandidate();
        else if (cause instanceof NotamRevisionConflict || cause instanceof NotamError && cause.code === 'unsupported-lifecycle') await invalidate(cause);
        throw cause;
      }
      return;
    }
    if (now() >= store!.nextBulkAt) {
      const bulk = await acquire('bulk'); validSignal();
      const records = mergeNotamRecords([], bulk.records);
      candidate = await store!.publish({ schemaVersion: 1, environment: environment!, records,
        checkedAt: bulk.snapshotAt, watermark: bulk.snapshotAt, baselineAt: bulk.snapshotAt,
        fullSyncAt: bulk.requestedAt, complete: false }, true);
      error = null; return;
    }
    try {
      if (!current || !current.complete) throw new NotamError(current?.incompleteReason ?? error ?? 'incomplete-checkpoint', store!.nextBulkAt);
      if (!inDeltaWindow(current)) throw new NotamError('delta-window-exceeded', store!.nextBulkAt);
      await applyDelta(current);
    } catch (cause) {
      if (cause instanceof NotamError && ['unsupported-lifecycle', 'revision-conflict', 'delta-window-exceeded'].includes(cause.code)) {
        await invalidate(cause);
      }
      throw cause;
    }
  }
  function refresh() {
    if (!initialized || !store || pending || stopped || dependencies.signal.aborted || now() < Math.max(retryAt, store.nextDataAt)) return;
    pending = round().catch(async cause => {
      if (dependencies.signal.aborted || stopped) return;
      failure(cause);
      if (cause instanceof NotamRevisionConflict) {
        try { await store.recordConflict(cause); }
        catch { dependencies.log?.('NOTAM conflict-diagnostic-unavailable'); }
      }
    }).finally(() => { pending = undefined; });
  }
  return {
    restore, refresh, get status() { return status(); },
    readAirport(query: NotamAirportQuery): NotamAirportSnapshot | undefined {
      if (!current) return undefined;
      const found = [...(query.faaId ? domestic.get(query.faaId) ?? [] : []), ...(query.icaoId ? icao.get(query.icaoId) ?? [] : [])];
      const records = [...new Map(found.map(r => [r.id, r])).values()];
      if (records.length > NOTAM_AIRPORT_MAX_RECORDS) throw new NotamError('airport-size-limit');
      return { schemaVersion: 1, query, feed: status(), scope: 'airport-location',
        associationCoverage: query.faaId ? 'complete' : 'incomplete', records };
    },
    async settled() { await pending; },
    async close() { stopped = true; await restoring; await pending; await store?.close(); },
  };
}
