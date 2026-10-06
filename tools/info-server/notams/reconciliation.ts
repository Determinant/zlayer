import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isRecord } from '@zlayer/contracts';
import { atomicStateFile, readStateJson } from '../state-file';
import type { NotamStore } from './store';
import { NOTAM_FULL_SYNC_MAX_AGE } from './policy';
import { notamError } from './error';

type History = { schemaVersion: 1; environment: string; attemptedAt: number;
  failure: { attemptedAt: number; at: number; code: string } | null };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const instant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 8.64e15;

/** Diagnostic history cannot grant quota, change a checkpoint, or freshen data. */
export class NotamReconciliation {
  private history: History;
  private historyError: string | null = null;
  constructor(private readonly store: NotamStore, private readonly now = Date.now,
    private readonly log?: (message: string) => void) {
    this.history = { schemaVersion: 1, environment: store.environment, attemptedAt: 0, failure: null };
  }
  async restore() {
    try {
      const value = await readStateJson(join(this.store.directory, 'reconciliation.json'));
      if (!isRecord(value)) throw new Error();
      const { sha256, ...content } = value, failure = content.failure;
      if (sha256 !== digest(content) || content.schemaVersion !== 1 || content.environment !== this.store.environment ||
        !instant(content.attemptedAt) || content.attemptedAt > this.now() || failure !== null && (!isRecord(failure) || !instant(failure.attemptedAt) ||
        !instant(failure.at) || failure.attemptedAt > content.attemptedAt || failure.at < failure.attemptedAt || failure.at > this.now() ||
        typeof failure.code !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(failure.code))) throw new Error();
      this.history = content as History;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') this.historyError = 'reconciliation-history-invalid';
    }
  }
  private async save(value: History) {
    this.history = value;
    try {
      this.store.assertHeld();
      await atomicStateFile(join(this.store.directory, 'reconciliation.json'), JSON.stringify({ ...value, sha256: digest(value) }));
      this.store.assertHeld(); this.historyError = null;
    } catch {
      // Collection still uses the independently authenticated admission journal.
      if (this.historyError !== 'reconciliation-history-unavailable') this.log?.('NOTAM reconciliation-history-unavailable');
      this.historyError = 'reconciliation-history-unavailable';
    }
  }
  async started(): Promise<number> {
    const attemptedAt = this.now();
    await this.save({ ...this.history, attemptedAt });
    return attemptedAt;
  }
  async failed(attemptedAt: number, cause: unknown) {
    await this.save({ ...this.history, attemptedAt: Math.max(attemptedAt, this.history.attemptedAt),
      failure: { attemptedAt, at: this.now(), code: notamError(cause) } });
  }
  status(fullSyncAt: number | null, pending: boolean) {
    const now = this.now(), { attemptedAt, failure } = this.history;
    const ageMs = fullSyncAt === null ? null : now - fullSyncAt;
    const overdue = ageMs !== null && (ageMs < 0 || ageMs >= NOTAM_FULL_SYNC_MAX_AGE);
    const failed = failure && (fullSyncAt === null || failure.attemptedAt > fullSyncAt);
    const interrupted = attemptedAt > (fullSyncAt ?? 0) && !pending;
    const error = this.historyError ?? (failed ? failure.code : interrupted ? 'reconciliation-interrupted' : null);
    return { state: error ? 'failed' : overdue ? 'overdue' : pending ? 'pending' : fullSyncAt === null ? 'unavailable' : 'current',
      fullSyncAt, ageMs, overdue, pending, lastAttemptAt: attemptedAt || null, lastFailure: failure, error,
      nextAttemptAt: this.store.nextBulkAt };
  }
}
