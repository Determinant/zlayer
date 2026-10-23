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
import { notamCancellationExpiresAt, NOTAM_BULK_PARSE_MS } from './policy';
import { NotamBulkSource, type SavedNotamBulk } from './bulk-source';
import { pendingNotamMembers, type NotamMemberRejection, type NotamPendingMember } from './ingestion';
import type { InfoMetrics } from '../metrics';
import { notamTime } from '../../../src/layers/notams/validity';

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
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>; sourceUrl?: string }) {
  const lifetime = new AbortController(), signal = AbortSignal.any([dependencies.signal, lifetime.signal]);
  const now = dependencies.now ?? Date.now, enabled = options?.enabled ?? false;
  const environment = options?.environment ?? null;
  const configurationValid = enabled && !!environment && !!options?.credentials && !options.configurationError;
  const store = configurationValid ? new NotamStore(join(options!.directory, environment!), environment!, now) : undefined;
  const source = store ? createNotamSource({ environment: environment!, credentials: options!.credentials!, admission: store.admission, ...dependencies, signal }) : undefined;
  const reconciliation = store ? new NotamReconciliation(store, now, dependencies.log) : undefined;
  const bulkSource = store ? new NotamBulkSource(store, now, dependencies.sourceUrl) : undefined;
  let retainedBulk: SavedNotamBulk | undefined, retainedBulkAttempted = false;
  let current: NotamGeneration | undefined, candidate: NotamGeneration | undefined;
  const indexes = new NotamIndex(now);
  let error: string | null = enabled && !configurationValid ? 'configuration-error' : null;
  let initialized = false, restoring: Promise<void> | undefined, pending: Promise<void> | undefined, stopped = false, quiescing = false;
  let retryAt = 0, recoveryAttempted = false, clock = now();
  let acquiringBulk = false;
  let recoveryFailure: unknown;
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
    const { blocking: blockingRecords, historical: historicalIssues } = indexes.sourceIssues;
    const continuity = collectionContinuity === 'complete' && !unresolvedRecords ? 'complete' : 'incomplete';
    return { enabled, environment, state: !enabled ? 'disabled' : !configurationValid ? 'unavailable'
      : !initialized && !error ? 'loading' : !current ? 'unavailable' : error || !fresh || collectionContinuity !== 'complete' || blockingRecords ? 'degraded' : 'ready',
      generation: current?.generation ?? null, checkedAt: current?.checkedAt ?? null, watermark: current?.watermark ?? null,
      fullSyncAt: current?.fullSyncAt ?? null, recordCount: (current?.records.length ?? 0) + unresolvedRecords,
      collectionContinuity, unresolvedRecords, blockingRecords, historicalIssues, unscopedRecords: indexes.unscopedCount,
      continuity, error: current?.incompleteReason ?? error ?? (blockingRecords ? 'unresolved-records' : null),
      nextAttemptAt: store ? initialized ? Math.max(retryAt, store.admission.nextDataAt, !current && !candidate ? store.admission.nextBulkAt : 0) : retryAt : null };
  }
  function restore(): Promise<void> {
    if (restoring) return restoring;
    if (initialized || stopped || quiescing || signal.aborted || now() < retryAt) return Promise.resolve();
    return restoring = (async () => {
      if (!store) { initialized = true; return; }
      try {
        const saved = await store.restore(); validSignal();
        error = null;
        if (saved) index(saved);
        else if (current) index({ ...current, complete: false, incompleteReason: 'invalid-checkpoint' });
        candidate = undefined; retainedBulk = undefined; recoveryAttempted = false;
        await reconciliation!.restore();
        if (store.recoveryError) error = store.recoveryError;
        if (saved && !saved.complete) error = saved.incompleteReason ?? error ?? 'incomplete-checkpoint';
        try { candidate = await store.restoreCandidate(); }
        catch (cause) { failure(cause); await store.discardCandidate(); }
        try { retainedBulk = await bulkSource!.restore(candidate?.fullSyncAt ?? saved?.fullSyncAt ?? null); }
        catch (cause) { failure(cause); await bulkSource!.discard(); }
        validSignal(); initialized = true; retryAt = 0; recoveryFailure = undefined;
      } catch (cause) { recoveryFailure = cause; initialized = false; if (!signal.aborted && !stopped) failure(cause); await store.close(); }
    })().finally(() => { restoring = undefined; });
  }
  async function acquire(kind: 'bulk' | 'delta', since?: number, retained?: SavedNotamBulk) {
    const path = join(store!.directory, `${randomUUID()}.source.tmp`), output = path.replace('.source.tmp', '.parsed.tmp');
    let requestedAt: number | undefined;
    const capture = async (reason: string) => {
      if (kind !== 'delta' || requestedAt === undefined || signal.aborted) return;
      try { await bulkSource!.saveDeltaFailure(path, requestedAt, reason); }
      catch { dependencies.log?.('NOTAM delta evidence unavailable'); }
    };
    try {
      ({ requestedAt } = retained ?? await measure(kind === 'bulk' ? 'notams.bulk' : 'notams.delta', () => source!.download(kind, path, since)));
      if (kind === 'bulk' && !retained) retainedBulk = await bulkSource!.save(path, requestedAt);
      const input = kind === 'bulk' ? retained ?? retainedBulk! : { path };
      const module = new URL(`../notams-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);
      // The bundle emits workers alongside main.js, while this source lives in notams/.
      const worker = import.meta.url.endsWith('.ts') ? module : new URL('./notams-worker.js', import.meta.url);
      type Parsed = { snapshotAt: number; count: number; bytes: number; rejected: NotamMemberRejection[] };
      let summary: Parsed;
      try { summary = await measure('notams.parse', () => workerJob<Parsed>(
        worker, { path: input.path, output, kind, requestedAt }, signal, [], kind === 'bulk' ? NOTAM_BULK_PARSE_MS : 60_000)); }
      catch (cause) {
        if (signal.aborted) throw cause;
        const code = cause instanceof Error && cause.name === 'TimeoutError' ? 'parse-timeout'
          : cause instanceof Error && /^[a-z][a-z0-9-]{0,63}$/.test(cause.message) ? cause.message : 'parse-failed';
        // Retain recoverable local failures; a rejected source envelope must not
        // displace ordinary deltas with the same deterministic error on restart.
        if (kind === 'bulk' && !['parse-timeout', 'parse-failed', 'storage-unavailable', 'internal-error'].includes(code)) {
          await bulkSource!.discard(); retainedBulk = undefined;
        }
        throw new NotamError(code);
      }
      validSignal();
      if (summary.snapshotAt > now() + 30_000 || summary.snapshotAt < now() - NOTAM_DAY_MS) throw new NotamError('invalid-source-boundary');
      const records: NotamRecord[] = [], stream = createReadStream(output);
      try {
        for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
          validSignal(); const record: unknown = JSON.parse(line);
          if (!isNotamRecord(record)) throw new NotamError('invalid-record');
          records.push(record);
          if (records.length > summary.count) throw new NotamError('incomplete-collection');
        }
      } finally { stream.destroy(); }
      if (records.length + summary.rejected.length !== summary.count) throw new NotamError('incomplete-collection');
      const latest = now() + 30_000;
      const rejected = [...summary.rejected.map(member => member.sourceUpdatedAt !== null && notamTime(member.sourceUpdatedAt)! > latest
        ? { ...member, sourceUpdatedAt: null } : member), ...records.filter(record => record.updatedAt > latest)
        .map(record => ({ id: record.id, reason: 'invalid-update-time', sourceUpdatedAt: null }))];
      if (rejected.length) {
        await capture('invalid-source-members');
        dependencies.log?.(`NOTAM rejected-members count=${rejected.length} samples=${JSON.stringify(rejected.slice(0, 16))}`);
      }
      return { records, rejected, snapshotAt: summary.snapshotAt, requestedAt };
    } catch (cause) { await capture(notamError(cause)); throw cause; }
    finally { await Promise.all([rm(path, { force: true }), rm(output, { force: true })]); }
  }
  const inDeltaWindow = (base: NotamGeneration) => base.watermark <= now() && base.watermark - OVERLAP_MS >= now() - NOTAM_DAY_MS;
  // A partial member update keeps the last verified prefix. Retrying from that
  // exact boundary can close the gap; damaged checkpoints have no such authority.
  const hasReplayPrefix = (base: NotamGeneration) => base.complete ||
    base.incompleteReason === 'invalid-source-members' && !!base.pendingMembers?.length;
  const liveCanDelta = () => current && hasReplayPrefix(current) && inDeltaWindow(current);
  const retainedMembers = (base: NotamGeneration | undefined) => base
    ? [...base.records, ...(base.issues ?? []).flatMap(issue => issue.variants)] : [];
  async function publishPartial(base: NotamGeneration, records: readonly NotamRecord[], pendingMembers: readonly NotamPendingMember[], kind: 'bulk' | 'delta', privateCandidate = false) {
    const blocked = new Set(pendingMembers.map(member => member.id));
    const collection = merge(() => collectNotamRecords(base, records.filter(record => !blocked.has(record.id)), { at: now(), kind }));
    const next = await measure('notams.persist', () => store!.publish({ ...base, ...collection,
      complete: false, incompleteReason: 'invalid-source-members', pendingMembers }, privateCandidate));
    validSignal();
    if (privateCandidate) candidate = next; else index(next);
  }
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
    const pendingFor = (prefix: NotamGeneration) => pendingNotamMembers(prefix.pendingMembers, delta.records, delta.rejected, delta.requestedAt,
      undefined, delta.rejected.length || prefix.pendingMembers?.length ? retainedMembers(prefix) : []);
    // A verified replacement can already have resolved the live generation's gaps.
    const pendingMembers = pendingFor(base);
    if (pendingMembers.length) {
      if (current && liveCanDelta()) {
        const livePending = current === base ? pendingMembers : pendingFor(current);
        if (livePending.length) await publishPartial(current, delta.records, livePending, 'delta');
      } else {
        // An unbridged bootstrap/recovery prefix stays private, including its gaps.
        await publishPartial(base, delta.records, pendingMembers, 'delta', true);
      }
      throw new NotamError('invalid-source-members');
    }
    const merged = merge(() => collectNotamRecords(base, delta.records, { at: now(), kind: 'delta' }));
    const expired = (record: NotamRecord) => (notamCancellationExpiresAt(record) ?? Infinity) <= now();
    const records = merged.records.some(expired) ? merged.records.filter(record => !expired(record)) : merged.records;
    const { incompleteReason: _reason, pendingMembers: _pending, ...verified } = base;
    const next = await measure('notams.persist', () => store!.publish({ ...verified, records, issues: merged.issues ?? NO_NOTAM_ISSUES,
      checkedAt: delta.requestedAt, watermark: delta.requestedAt,
      complete: true }));
    if ((next.issues?.length ?? 0) !== (current?.issues?.length ?? 0)) dependencies.log?.(`NOTAM unresolved-records count=${next.issues?.length ?? 0}`);
    validSignal(); index(next); candidate = undefined; error = null; recoveryAttempted = false;
  }
  async function round() {
    validSignal();
    if (candidate && !inDeltaWindow(candidate) && !candidate.pendingMembers?.length) await discardCandidate();
    // A repeatedly failing replay must not starve an available full rebase.
    // Keep any usable candidate until a new bulk has validated and been saved,
    // so a failed bulk attempt still permits ordinary budgeted replay afterward.
    const replay = retainedBulk && !retainedBulkAttempted && now() < store!.admission.nextBulkAt ? retainedBulk : undefined;
    if (now() >= store!.admission.nextBulkAt || replay) {
      acquiringBulk = true;
      retainedBulkAttempted = true;
      const attemptedAt = replay?.requestedAt ?? await reconciliation!.started();
      try {
        const bulk = await acquire('bulk', undefined, replay); validSignal();
        // Failed private bridges retain evidence even after their replay window ends.
        const prefix = candidate ?? current;
        const pendingFor = (base: NotamGeneration | undefined) => pendingNotamMembers(base?.pendingMembers, bulk.records, bulk.rejected, bulk.requestedAt, bulk.snapshotAt,
          bulk.rejected.length || base?.pendingMembers?.length ? retainedMembers(base) : []);
        const pendingMembers = pendingFor(prefix);
        if (pendingMembers.length) {
          // Incomplete full snapshots cannot withdraw absent IDs or establish a
          // new baseline. An existing verified prefix can still accept updates.
          if (current && liveCanDelta()) {
            const livePending = current === prefix ? pendingMembers : pendingFor(current);
            if (livePending.length) await publishPartial(current, bulk.records, livePending, 'bulk');
          } else if (candidate) await publishPartial(candidate, bulk.records, pendingMembers, 'bulk', true);
          throw new NotamError('invalid-source-members');
        }
        const collection = merge(() => current ? rebaseNotamRecords(current, bulk.records, bulk.snapshotAt >= current.watermark ? bulk.snapshotAt : undefined,
          { at: now(), kind: 'bulk' }, bulk.rejected.map(member => member.id))
          : collectNotamRecords({ records: [] }, bulk.records, { at: now(), kind: 'bulk' }));
        candidate = await measure('notams.persist', () => store!.publish({ schemaVersion: 2, environment: environment!, ...collection,
          checkedAt: bulk.snapshotAt, watermark: bulk.snapshotAt, baselineAt: bulk.snapshotAt,
          fullSyncAt: bulk.requestedAt, complete: false }, true));
        await bulkSource!.discard(); retainedBulk = undefined;
        error = null;
      } catch (cause) {
        if (!signal.aborted) await reconciliation!.failed(attemptedAt, cause);
        throw cause;
      } finally { acquiringBulk = false; }
      return;
    }
    if (!candidate && current && !hasReplayPrefix(current) && !recoveryAttempted) {
      recoveryAttempted = true;
      const previous = await store!.restorePrevious(); validSignal();
      if (previous && inDeltaWindow(previous)) candidate = previous;
    }
    if (candidate) {
      if (!inDeltaWindow(candidate)) throw new NotamError('delta-window-exceeded', store!.admission.nextBulkAt);
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
      if (!current || !hasReplayPrefix(current)) throw new NotamError(current?.incompleteReason ?? error ?? 'incomplete-checkpoint', store!.admission.nextBulkAt);
      if (!inDeltaWindow(current)) throw new NotamError('delta-window-exceeded', store!.admission.nextBulkAt);
      await applyDelta(current);
    } catch (cause) {
      if (cause instanceof NotamError && cause.code === 'delta-window-exceeded') {
        await invalidate(cause);
      }
      throw cause;
    }
  }
  function refresh() {
    if (now() < clock) retryAt = Math.min(retryAt, now() + NOTAM_REFRESH_MS);
    clock = now();
    if (!store || pending || stopped || quiescing || signal.aborted) return;
    if (!initialized) { void restore(); return; }
    if (restoring || now() < Math.max(retryAt, store.admission.nextDataAt)) return;
    pending = measure('notams.round', round).catch(async cause => {
      if (signal.aborted || stopped) return;
      failure(cause);
      let held = true;
      try { store.assertHeld(); } catch (cause) { held = false; recoveryFailure = cause; }
      if (!held || !store.admission.ready) {
        recoveryFailure ??= cause; initialized = false;
        await store.close();
      }
    }).finally(() => { pending = undefined; });
  }
  return {
    restore, refresh, get status() { return status(); },
    get ingestion() { const members = candidate?.pendingMembers ?? current?.pendingMembers ?? [];
      return { pending: members.length, samples: members.slice(0, 16), samplesTruncated: members.length > 16 }; },
    get sourceIssues() { return current ? indexes.sourceIssues : null; },
    get reconciliation() { return reconciliation?.status(current?.fullSyncAt ?? null,
      acquiringBulk || !!candidate || !!retainedBulk && !retainedBulkAttempted) ?? null; },
    readRegion(query: NotamRegionQuery): NotamRegionSnapshot | undefined {
      if (!current) return undefined;
      const { records, issues, historicalIssues } = indexes.read(query.artccId, query.firId);
      const feed = status();
      return { schemaVersion: 1, query, feed, scope: 'region-location',
        associationCoverage: query.artccId ? 'complete' : 'incomplete', records, issues, ...(historicalIssues ? { historicalIssues } : {}),
        contentCoverage: feed.collectionContinuity === 'complete' && !issues.length ? 'complete' : 'incomplete' };
    },
    readNavaid(query: NotamNavaidQuery): NotamNavaidSnapshot | undefined {
      if (!current) return undefined;
      const { records, issues, historicalIssues } = indexes.read(query.navaidId);
      const feed = status();
      // Preserve the schema-1 value accepted by already deployed clients.
      return { schemaVersion: 1, query, feed, scope: 'navaid-location', associationCoverage: 'incomplete', records, issues, ...(historicalIssues ? { historicalIssues } : {}),
        contentCoverage: feed.collectionContinuity === 'complete' && !issues.length ? 'complete' : 'incomplete' };
    },
    readAirport(query: NotamAirportQuery): NotamAirportSnapshot | undefined {
      if (!current) return undefined;
      const { records, issues, historicalIssues } = indexes.read(query.faaId, query.icaoId);
      const feed = status();
      return { schemaVersion: 1, query, feed, scope: 'airport-location',
        associationCoverage: query.faaId ? 'complete' : 'incomplete', records, issues, ...(historicalIssues ? { historicalIssues } : {}),
        contentCoverage: feed.collectionContinuity === 'complete' && !issues.length ? 'complete' : 'incomplete' };
    },
    async settled() { await restoring; await pending; },
    // One admitted round finishes its verified generation or durable candidate.
    // Quiescing never admits a second round or releases the writer lock.
    async quiesce() { quiescing = true; await restoring; await pending; if (recoveryFailure) throw recoveryFailure; if (initialized) store?.assertHeld(); },
    async close() { stopped = true; lifetime.abort(); await restoring; await pending; await store?.close(); },
  };
}
