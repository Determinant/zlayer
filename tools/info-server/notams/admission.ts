import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord, NOTAM_REFRESH_MS, type NotamEnvironment } from '@zlayer/contracts';
import { atomicStateFile, readStateJson } from '../state-file';
import { NOTAM_DAY_MS } from './policy';
import { NotamError } from './error';

type Journal = { schemaVersion: 1 | 2; environment: NotamEnvironment; lastAttemptAt: number; dataAt: number; bulkAt: number; anyAt: number; backoffAt: number; authAt?: number; sha256?: string };
export type NotamReservation = { kind: 'bulk' | 'delta' | 'auth' | 'content'; reservedAt: number; dispatchBy: number };
const instant = (v: unknown): v is number => Number.isSafeInteger(v) && typeof v === 'number' && v >= 0;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Durable pre-request admission, independent of dataset publication/recovery.
 * The owning store holds the writer lock through restore, queued writes and drain. */
export class NotamAdmission {
  private journal: Journal | undefined;
  private budgetWrite: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, private readonly environment: NotamEnvironment,
    readonly assertHeld: () => void, private readonly now = Date.now) {}
  get ready() { return !!this.journal; }
  get nextDataAt() { return Math.max(this.journal?.dataAt ?? 0, this.journal?.backoffAt ?? 0); }
  get nextBulkAt() { return Math.max(this.nextDataAt, this.journal?.bulkAt ?? 0); }
  get nextAnyAt() { return Math.max(this.journal?.anyAt ?? 0, this.journal?.backoffAt ?? 0); }
  get nextAuthAt() {
    // Legacy journals do not identify the last request kind. Conservatively
    // allow one collection interval before another token attempt after restart.
    return Math.max(this.journal?.authAt ?? (this.journal?.lastAttemptAt ? this.journal.lastAttemptAt + NOTAM_REFRESH_MS : 0), this.nextAnyAt);
  }
  private async saveJournal(journal: Journal) {
    this.assertHeld();
    try {
      const { sha256: _sha256, ...fields } = journal;
      const content = { ...fields, schemaVersion: 2 as const }, saved = { ...content, sha256: digest(content) };
      await atomicStateFile(join(this.directory, 'budget.json'), JSON.stringify(saved));
      this.assertHeld(); this.journal = saved;
    } catch (cause) {
      // An uncertain write must never be followed by admission from old memory.
      this.journal = undefined; throw cause;
    }
  }
  private updateJournal(update: (journal: Journal) => Journal): Promise<void> {
    const write = this.budgetWrite.then(() => {
      if (!this.journal) throw new NotamError('storage-unavailable');
      return this.saveJournal(update(this.journal));
    });
    this.budgetWrite = write.catch(() => {});
    return write;
  }
  async restore() {
    this.journal = undefined;
    this.assertHeld();
    const provisioned = join(this.directory, 'provisioned');
    let exists = true;
    try { await stat(provisioned); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw e; }
    if (!exists) {
      // Mark before creating allowance. An interrupted provisioning cannot reset a spent budget.
      await atomicStateFile(provisioned, this.environment);
      if ((await readdir(this.directory)).some(name => name === 'bulk-archive' || name === 'delta-failures' || /^(budget|current|previous|candidate|reconciliation|bulk-source)\.json$|\.ndjson$|^bulk-source-.*\.bin$/.test(name))) {
        throw new NotamError('state-recovery-required');
      }
      await this.saveJournal({ schemaVersion: 1, environment: this.environment, lastAttemptAt: 0, dataAt: 0, bulkAt: 0, anyAt: 0, backoffAt: 0, authAt: 0 });
    } else {
      let value: unknown;
      try { value = await readStateJson(join(this.directory, 'budget.json')); }
      catch { throw new NotamError('invalid-budget'); }
      if (!isRecord(value) || value.schemaVersion !== 1 && value.schemaVersion !== 2 || value.environment !== this.environment ||
        !['lastAttemptAt', 'dataAt', 'bulkAt', 'anyAt', 'backoffAt'].every(k => instant(value[k])) ||
        value.authAt !== undefined && !instant(value.authAt)) throw new NotamError('invalid-budget');
      const { sha256, ...content } = value;
      if (value.schemaVersion === 2 ? typeof sha256 !== 'string' || sha256 !== digest(content) : sha256 !== undefined) throw new NotamError('invalid-budget');
      if (value.lastAttemptAt === 0 ? value.anyAt !== 0 : Number(value.anyAt) < Number(value.lastAttemptAt) + 1000) throw new NotamError('invalid-budget');
      this.journal = value as Journal;
    }
  }
  async reserve(kind: NotamReservation['kind'], startWithinMs = 0): Promise<NotamReservation> {
    if (!instant(startWithinMs) || startWithinMs > 120_000) throw new NotamError('invalid-reservation');
    let reservation: NotamReservation;
    await this.updateJournal(journal => {
      const now = this.now(), due = Math.max(this.nextAnyAt, kind === 'bulk' ? this.nextBulkAt : kind === 'delta' ? this.nextDataAt : kind === 'auth' ? this.nextAuthAt : 0);
      if (now < due || now < journal.lastAttemptAt) throw new NotamError('request-budget', Math.max(due, journal.lastAttemptAt));
      const dispatchBy = now + startWithinMs; reservation = { kind, reservedAt: now, dispatchBy };
      // Charge through the latest permitted dispatch BEFORE sending anything.
      // A crash or slow fsync cannot shorten actual request spacing.
      return { ...journal, lastAttemptAt: now, anyAt: dispatchBy + 1000,
        ...(['bulk', 'delta'].includes(kind) ? { dataAt: dispatchBy + NOTAM_REFRESH_MS } : {}),
        ...(kind === 'auth' ? { authAt: dispatchBy + NOTAM_REFRESH_MS } : {}),
        ...(kind === 'bulk' ? { bulkAt: dispatchBy + NOTAM_DAY_MS } : {}) };
    });
    return reservation!;
  }
  async finishRequest(reservation: NotamReservation, backoffAt = 0) {
    if (!instant(backoffAt)) throw new NotamError('invalid-source-backoff');
    await this.updateJournal(journal => {
      if (journal.lastAttemptAt !== reservation.reservedAt || journal.anyAt !== reservation.dispatchBy + 1000) throw new NotamError('invalid-reservation');
      const completedAt = Math.max(this.now(), reservation.reservedAt), { kind } = reservation;
      // Once an attempt has finished, anchor its cooldown to completion. Only
      // that outstanding reservation can release its provisional crash margin.
      return { ...journal, lastAttemptAt: completedAt, anyAt: completedAt + 1000,
        backoffAt: Math.max(journal.backoffAt, backoffAt),
        ...(['bulk', 'delta'].includes(kind) ? { dataAt: completedAt + NOTAM_REFRESH_MS } : {}),
        ...(kind === 'auth' ? { authAt: completedAt + NOTAM_REFRESH_MS } : {}),
        ...(kind === 'bulk' ? { bulkAt: completedAt + NOTAM_DAY_MS } : {}) };
    });
  }
  async backoff(until: number) {
    if (!instant(until)) throw new NotamError('invalid-source-backoff');
    await this.updateJournal(journal => ({ ...journal, backoffAt: Math.max(journal.backoffAt, until) }));
  }
  async settled() { await this.budgetWrite; }
}
