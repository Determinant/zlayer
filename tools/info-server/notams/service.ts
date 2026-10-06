import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { isNotamRecord, NOTAM_REFRESH_MS, NOTAM_STALE_MS,
  type NotamAirportQuery, type NotamAirportSnapshot, type NotamNavaidQuery, type NotamNavaidSnapshot,
  type NotamRegionQuery, type NotamRegionSnapshot,
  type NotamEnvironment, type NotamFeedStatus, type NotamRecord } from '@zlayer/contracts';
import { workerJob } from '../worker-job';
import { createNotamSource, type NotamCredentials } from './client';
import { NotamError, notamError } from './error';
import { NOTAM_DAY_MS, NotamStore, type NotamGeneration } from './store';
import { collectNotamRecords, rebaseNotamRecords, NO_NOTAM_ISSUES } from './collection';
import { NotamReconciliation } from './reconciliation';
import { NotamIndex } from './index';
import type { InfoMetrics } from '../metrics';

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

export function createNotamService(options: NotamOptions | undefined,
  dependencies: { signal: AbortSignal; fetch?: typeof fetch; now?: () => number; log?: (message: string) => void; metrics?: InfoMetrics;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void> }) {
  const lifetime = new AbortController(), signal = AbortSignal.any([dependencies.signal, lifetime.signal]);
  const now = dependencies.now ?? Date.now, enabled = options?.enabled ?? false;
  const environment = options?.environment ?? null;
  const configurationValid = enabled && !!environment && !!options?.credentials && !options.configurationError;
  const store = configurationValid ? new NotamStore(join(options!.directory, environment!), environment!, now) : undefined;
  const source = store ? createNotamSource({ environment: environment!, credentials: options!.credentials!, store, ...dependencies, signal }) : undefined;
  const reconciliation = store ? new NotamReconciliation(store, now, dependencies.log) : undefined;
  let current: NotamGeneration | undefined, candidate: NotamGeneration | undefined;
  const indexes = new NotamIndex();
  let error: string | null = enabled && !configurationValid ? 'configuration-error' : null;
  let initialized = false, restoring: Promise<void> | undefined, pending: Promise<void> | undefined, stopped = false;
  let retryAt = 0, recoveryAttempted = false;
  let acquiringBulk = false;
  const validSignal = () => { signal.throwIfAborted(); if (stopped) throw new NotamError('stopping'); };
  function index(generation: NotamGeneration) {
    const publish = () => { indexes.publish(generation); current = generation; };
    if (dependencies.metrics) dependencies.metrics.measureSync('notams.index', publish); else publish();
  }
  const measure = <T>(name: 'notams.bulk' | 'notams.delta' | 'notams.parse' | 'notams.persist' | 'notams.round', work: () => Promise<T>) =>
    dependencies.metrics ? dependencies.metrics.measure(name, work) : work();
  const merge = <T>(work: () => T) => dependencies.metrics ? dependencies.metrics.measureSync('notams.merge', work) : work();
  function failure(cause: unknown) {
    error = notamError(cause); retryAt = Math.max(now() + NOTAM_REFRESH_MS, cause instanceof NotamError ? cause.retryAt ?? 0 : 0);
    dependencies.log?.(`NOTAM ${error}`);
  }
  function status(): NotamFeedStatus {
    const fresh = current && now() >= current.checkedAt && now() - current.checkedAt < NOTAM_STALE_MS;
    const collectionContinuity = current?.complete && now() >= current.watermark && now() - current.watermark + OVERLAP_MS < NOTAM_DAY_MS ? 'complete' : 'incomplete';
    const unresolvedRecords = current?.issues?.length ?? 0;
    const continuity = collectionContinuity === 'complete' && !unresolvedRecords ? 'complete' : 'incomplete';
    return { enabled, environment, state: !enabled ? 'disabled' : !configurationValid ? 'unavailable'
      : !initialized && !error ? 'loading' : !current ? 'unavailable' : error || !fresh || continuity !== 'complete' ? 'degraded' : 'ready',
      generation: current?.generation ?? null, checkedAt: current?.checkedAt ?? null, watermark: current?.watermark ?? null,
      fullSyncAt: current?.fullSyncAt ?? null, recordCount: (current?.records.length ?? 0) + unresolvedRecords,
      collectionContinuity, unresolvedRecords, unscopedRecords: indexes.unscopedCount,
      continuity, error: current?.incompleteReason ?? error ?? (unresolvedRecords ? 'unresolved-records' : null),
      nextAttemptAt: store && initialized ? Math.max(retryAt, store.nextDataAt, !current && !candidate ? store.nextBulkAt : 0) : null };
  }
  function restore(): Promise<void> {
    return restoring ??= (async () => {
      if (!store) { initialized = true; return; }
      try {
        const saved = await store.restore(); validSignal(); if (saved) index(saved);
        await reconciliation!.restore();
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
      const { requestedAt } = await measure(kind === 'bulk' ? 'notams.bulk' : 'notams.delta', () => source!.download(kind, path, since));
      const module = new URL(`../notams-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);
      // The bundle emits workers alongside main.js, while this source lives in notams/.
      const worker = import.meta.url.endsWith('.ts') ? module : new URL('./notams-worker.js', import.meta.url);
      let summary: { snapshotAt: number; count: number; bytes: number };
      try { summary = await measure('notams.parse', () => workerJob<{ snapshotAt: number; count: number; bytes: number }>(worker, { path, output, kind, requestedAt }, signal)); }
      catch (cause) { throw new NotamError(cause instanceof Error && /^[a-z][a-z0-9-]{0,63}$/.test(cause.message) ? cause.message : 'parse-failed'); }
      validSignal();
      if (summary.snapshotAt > now() + 30_000 || summary.snapshotAt < now() - NOTAM_DAY_MS) throw new NotamError('invalid-source-boundary');
      const records: NotamRecord[] = [], stream = createReadStream(output);
      try {
        for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
          validSignal(); const record: unknown = JSON.parse(line);
          if (!isNotamRecord(record) || record.updatedAt > now() + 30_000) throw new NotamError('invalid-record');
          records.push(record);
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
    if (delta.requestedAt < base.watermark || current && delta.requestedAt < current.watermark) throw new NotamError('invalid-source-boundary');
    const merged = merge(() => collectNotamRecords(base, delta.records));
    const expired = (record: NotamRecord) => ['cancelled', 'cancellation'].includes(record.lifecycle) && record.updatedAt < now() - 2 * NOTAM_DAY_MS;
    const records = merged.records.some(expired) ? merged.records.filter(record => !expired(record)) : merged.records;
    const { incompleteReason: _reason, ...verified } = base;
    const next = await measure('notams.persist', () => store!.publish({ ...verified, records, issues: merged.issues ?? NO_NOTAM_ISSUES,
      checkedAt: delta.requestedAt, watermark: delta.requestedAt,
      complete: true }));
    if ((next.issues?.length ?? 0) !== (current?.issues?.length ?? 0)) dependencies.log?.(`NOTAM unresolved-records count=${next.issues?.length ?? 0}`);
    validSignal(); index(next); candidate = undefined; error = null; recoveryAttempted = false;
  }
  async function round() {
    validSignal();
    if (candidate && !inDeltaWindow(candidate)) await discardCandidate();
    // A repeatedly failing replay must not starve an available full rebase.
    // Keep any usable candidate until a new bulk has validated and been saved,
    // so a failed bulk attempt still permits ordinary budgeted replay afterward.
    if (now() >= store!.nextBulkAt) {
      acquiringBulk = true;
      const attemptedAt = await reconciliation!.started();
      try {
        const bulk = await acquire('bulk'); validSignal();
        const collection = merge(() => current ? rebaseNotamRecords(current, bulk.records, bulk.snapshotAt >= current.watermark ? bulk.snapshotAt : undefined)
          : collectNotamRecords({ records: [] }, bulk.records));
        candidate = await measure('notams.persist', () => store!.publish({ schemaVersion: 2, environment: environment!, ...collection,
          checkedAt: bulk.snapshotAt, watermark: bulk.snapshotAt, baselineAt: bulk.snapshotAt,
          fullSyncAt: bulk.requestedAt, complete: false }, true));
        error = null;
      } catch (cause) {
        if (!signal.aborted) await reconciliation!.failed(attemptedAt, cause);
        throw cause;
      } finally { acquiringBulk = false; }
      return;
    }
    if (!candidate && current && !current.complete && !recoveryAttempted) {
      recoveryAttempted = true;
      const previous = await store!.restorePrevious(); validSignal();
      if (previous && inDeltaWindow(previous)) candidate = previous;
    }
    if (candidate) {
      const bridging = candidate;
      try { await applyDelta(bridging); }
      catch (cause) {
        if (!signal.aborted) await reconciliation!.failed(bridging.fullSyncAt, cause);
        // A failed replacement does not discredit the live dataset. Its next
        // budgeted round continues live deltas, rather than retrying a bad bridge.
        if (liveCanDelta()) await discardCandidate();
        throw cause;
      }
      return;
    }
    try {
      if (!current || !current.complete) throw new NotamError(current?.incompleteReason ?? error ?? 'incomplete-checkpoint', store!.nextBulkAt);
      if (!inDeltaWindow(current)) throw new NotamError('delta-window-exceeded', store!.nextBulkAt);
      await applyDelta(current);
    } catch (cause) {
      if (cause instanceof NotamError && cause.code === 'delta-window-exceeded') {
        await invalidate(cause);
      }
      throw cause;
    }
  }
  function refresh() {
    if (!initialized || !store || pending || stopped || signal.aborted || now() < Math.max(retryAt, store.nextDataAt)) return;
    pending = measure('notams.round', round).catch(async cause => {
      if (signal.aborted || stopped) return;
      failure(cause);
    }).finally(() => { pending = undefined; });
  }
  return {
    restore, refresh, get status() { return status(); },
    get reconciliation() { return reconciliation?.status(current?.fullSyncAt ?? null, acquiringBulk || !!candidate) ?? null; },
    readRegion(query: NotamRegionQuery): NotamRegionSnapshot | undefined {
      if (!current) return undefined;
      const { records, issues } = indexes.read(query.artccId, query.firId);
      const feed = status();
      return { schemaVersion: 1, query, feed, scope: 'region-location',
        associationCoverage: query.artccId ? 'complete' : 'incomplete', records, issues,
        contentCoverage: feed.collectionContinuity === 'complete' && !issues.length ? 'complete' : 'incomplete' };
    },
    readNavaid(query: NotamNavaidQuery): NotamNavaidSnapshot | undefined {
      if (!current) return undefined;
      const { records, issues } = indexes.read(query.navaidId);
      const feed = status();
      // Preserve the schema-1 value accepted by already deployed clients.
      return { schemaVersion: 1, query, feed, scope: 'navaid-location', associationCoverage: 'incomplete', records, issues,
        contentCoverage: feed.collectionContinuity === 'complete' && !issues.length ? 'complete' : 'incomplete' };
    },
    readAirport(query: NotamAirportQuery): NotamAirportSnapshot | undefined {
      if (!current) return undefined;
      const { records, issues } = indexes.read(query.faaId, query.icaoId);
      const feed = status();
      return { schemaVersion: 1, query, feed, scope: 'airport-location',
        associationCoverage: query.faaId ? 'complete' : 'incomplete', records, issues,
        contentCoverage: feed.collectionContinuity === 'complete' && !issues.length ? 'complete' : 'incomplete' };
    },
    async settled() { await pending; },
    async close() { stopped = true; lifetime.abort(); await restoring; await pending; await store?.close(); },
  };
}
