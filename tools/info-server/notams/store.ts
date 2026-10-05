import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isRecord, isNotamRecord, isNotamSourceIssue, type NotamRecord, type NotamSourceIssue, type NotamEnvironment, NOTAM_REFRESH_MS } from '@zlayer/contracts';
import { acquireNotamLock } from './lock';
import { NotamError } from './error';
import { upgradeNotamRecord } from './normalize';
import { NO_NOTAM_ISSUES } from './collection';

export const NOTAM_DAY_MS = 86_400_000;
export const NOTAM_GENERATION_MAX_BYTES = 256 * 1024 * 1024;
export type NotamGeneration = { schemaVersion: 1 | 2; environment: NotamEnvironment; generation: string;
  checkedAt: number; watermark: number; fullSyncAt: number; baselineAt: number; complete: boolean;
  incompleteReason?: string; records: readonly NotamRecord[]; issues?: readonly NotamSourceIssue[] };
type Manifest = Omit<NotamGeneration, 'records' | 'issues'> & { count: number; bytes: number; issueCount?: number; sha256?: string };
type Contents = Pick<Manifest, 'generation' | 'count' | 'bytes'>;
type Journal = { schemaVersion: 1 | 2; environment: NotamEnvironment; lastAttemptAt: number; dataAt: number; bulkAt: number; anyAt: number; backoffAt: number; authAt?: number; sha256?: string };
export type NotamReservation = { kind: 'bulk' | 'delta' | 'auth' | 'content'; reservedAt: number; dispatchBy: number };
const instant = (v: unknown): v is number => Number.isSafeInteger(v) && typeof v === 'number' && v >= 0;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sealManifest(value: Manifest): Manifest {
  const { sha256: _sha256, ...fields } = value;
  const content = { ...fields, schemaVersion: 2 as const, issueCount: fields.issueCount ?? 0 };
  return { ...content, sha256: digest(content) };
}
async function readMetadata(path: string): Promise<unknown> {
  const handle = await open(path, 'r');
  try {
    if ((await handle.stat()).size > 16 * 1024) throw new SyntaxError('NOTAM metadata size limit');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

export async function atomicNotamFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  catch (cause) { await rm(temporary, { force: true }); throw cause; }
  finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(join(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class NotamStore {
  private lock: Awaited<ReturnType<typeof acquireNotamLock>> | undefined;
  private journal: Journal | undefined;
  private budgetWrite: Promise<void> = Promise.resolve();
  private manifest: Manifest | undefined;
  private readonly contents = new Map<readonly NotamRecord[], Contents & { issues: readonly NotamSourceIssue[] }>();
  recoveryError: 'invalid-checkpoint' | undefined;
  constructor(readonly directory: string, readonly environment: NotamEnvironment, private readonly now = Date.now) {}
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
      await atomicNotamFile(join(this.directory, 'budget.json'), JSON.stringify(saved));
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
  assertHeld() {
    if (!this.lock) throw new NotamError('storage-unavailable');
    this.lock.assertHeld();
  }
  private remember(records: readonly NotamRecord[], issues: readonly NotamSourceIssue[], contents: Contents) {
    for (const [old, saved] of this.contents) if (saved.generation === contents.generation) this.contents.delete(old);
    this.contents.set(records, { ...contents, issues });
  }
  async restore(): Promise<NotamGeneration | undefined> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.lock = await acquireNotamLock(join(this.directory, 'writer.lock'));
    const provisioned = join(this.directory, 'provisioned');
    let exists = true;
    try { await stat(provisioned); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw e; }
    if (!exists) {
      // Mark before creating allowance. An interrupted provisioning cannot reset a spent budget.
      await atomicNotamFile(provisioned, this.environment);
      if ((await readdir(this.directory)).some(name => /^(budget|current|previous|candidate)\.json$|\.ndjson$/.test(name))) {
        throw new NotamError('state-recovery-required');
      }
      await this.saveJournal({ schemaVersion: 1, environment: this.environment, lastAttemptAt: 0, dataAt: 0, bulkAt: 0, anyAt: 0, backoffAt: 0, authAt: 0 });
    } else {
      let value: unknown;
      try { value = await readMetadata(join(this.directory, 'budget.json')); }
      catch { throw new NotamError('invalid-budget'); }
      if (!isRecord(value) || value.schemaVersion !== 1 && value.schemaVersion !== 2 || value.environment !== this.environment ||
        !['lastAttemptAt', 'dataAt', 'bulkAt', 'anyAt', 'backoffAt'].every(k => instant(value[k])) ||
        value.authAt !== undefined && !instant(value.authAt)) throw new NotamError('invalid-budget');
      const { sha256, ...content } = value;
      if (value.schemaVersion === 2 ? typeof sha256 !== 'string' || sha256 !== digest(content) : sha256 !== undefined) throw new NotamError('invalid-budget');
      if (value.lastAttemptAt === 0 ? value.anyAt !== 0 : Number(value.anyAt) < Number(value.lastAttemptAt) + 1000) throw new NotamError('invalid-budget');
      this.journal = value as Journal;
    }
    // Only the lock owner may discard private, interrupted writes.
    for (const name of await readdir(this.directory)) if (name.endsWith('.tmp')) await rm(join(this.directory, name), { force: true });
    await this.prune();
    let damaged = false;
    for (const name of ['current.json', 'previous.json']) {
      let found = false;
      try {
        const manifest = await readMetadata(join(this.directory, name));
        found = true;
        const generation = await this.readGeneration(manifest, name);
        const { records: _records, issues: _issues, ...metadata } = generation;
        const { issues: _savedIssues, ...contents } = this.contents.get(generation.records)!;
        this.manifest = { ...metadata, ...contents, issueCount: generation.issues?.length ?? 0 };
        if (damaged) { generation.complete = false; this.recoveryError = 'invalid-checkpoint'; }
        return generation;
      } catch (error) {
        if (found || (error as NodeJS.ErrnoException).code !== 'ENOENT') damaged = true;
      }
    }
    if (damaged) this.recoveryError = 'invalid-checkpoint';
    return undefined;
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
  async restoreCandidate(): Promise<NotamGeneration | undefined> {
    try {
      const value = await readMetadata(join(this.directory, 'candidate.json'));
      return await this.readGeneration(value, 'candidate.json');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new NotamError('invalid-candidate');
    } finally { await this.prune(); }
  }
  async discardCandidate() {
    this.assertHeld();
    await rm(join(this.directory, 'candidate.json'), { force: true });
    await this.prune();
  }
  async restorePrevious(): Promise<NotamGeneration | undefined> {
    try {
      const value = await readMetadata(join(this.directory, 'previous.json'));
      const previous = await this.readGeneration(value, 'previous.json');
      return previous.complete ? previous : undefined;
    } catch { return undefined; /* Only an authenticated complete checkpoint can seed replay. */ }
  }
  async invalidate(reason: string) {
    this.assertHeld();
    if (!this.manifest) return;
    // The rejected delta never changed this verified prefix. Retain its exact
    // boundary for a complete replay; the visible current state stays incomplete.
    if (this.manifest.complete) await atomicNotamFile(join(this.directory, 'previous.json'), JSON.stringify(this.manifest));
    const manifest = sealManifest({ ...this.manifest, complete: false, incompleteReason: reason });
    await atomicNotamFile(join(this.directory, 'current.json'), JSON.stringify(manifest));
    this.manifest = manifest;
  }
  private async readGeneration(value: unknown, name: string): Promise<NotamGeneration> {
    if (!isRecord(value) || value.schemaVersion !== 1 && value.schemaVersion !== 2 || value.environment !== this.environment ||
      typeof value.generation !== 'string' || !/^[a-f0-9]{64}$/.test(value.generation) || typeof value.complete !== 'boolean' ||
      value.incompleteReason !== undefined && (typeof value.incompleteReason !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.incompleteReason)) ||
      !['checkedAt', 'watermark', 'fullSyncAt', 'baselineAt', 'bytes', 'count'].every(k => instant(value[k])) ||
      value.schemaVersion === 2 && (!instant(value.issueCount) || Number(value.issueCount) + Number(value.count) > 150_000) ||
      Number(value.bytes) > NOTAM_GENERATION_MAX_BYTES || Number(value.count) > 150_000 || Number(value.watermark) > this.now()) {
      throw new NotamError('invalid-checkpoint');
    }
    const { sha256, ...content } = value;
    if (value.schemaVersion === 2 ? typeof sha256 !== 'string' || sha256 !== digest(content) : sha256 !== undefined) throw new NotamError('invalid-checkpoint');
    const manifest = value as Manifest, path = join(this.directory, `${manifest.generation}.ndjson`);
    if ((await stat(path)).size !== manifest.bytes) throw new NotamError('invalid-checkpoint');
    const hash = createHash('sha256'), records: NotamRecord[] = [], issues: NotamSourceIssue[] = [], ids = new Set<string>();
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    try { for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      // The generation byte limit above also bounds line allocation. A lower
      // line limit can reject valid multi-version evidence after JSON escaping.
      // Record fields and issue variant counts are checked independently below.
      const record: unknown = JSON.parse(line);
      if (manifest.schemaVersion === 2 && isRecord(record) && record.kind === 'issue' && isNotamSourceIssue(record.issue)) {
        if (ids.has(record.issue.id)) throw new NotamError('invalid-checkpoint');
        ids.add(record.issue.id); issues.push(record.issue);
      } else {
        if (!isNotamRecord(record) || ids.has(record.id)) throw new NotamError('invalid-checkpoint');
        ids.add(record.id); records.push(record);
      }
      if (records.length > manifest.count || issues.length > (manifest.issueCount ?? 0)) throw new NotamError('invalid-checkpoint');
    } } finally { stream.destroy(); }
    if (records.length !== manifest.count || issues.length !== (manifest.issueCount ?? 0) || hash.digest('hex') !== manifest.generation) throw new NotamError('invalid-checkpoint');
    const upgraded = records.map(upgradeNotamRecord);
    // Unresolved variants are source evidence. Do not silently clear their issues
    // during a derivation upgrade or while restoring a checkpoint.
    if (upgraded.some((record, index) => record !== records[index])) {
      const next = sealManifest({ ...manifest, ...await this.saveRecords(upgraded, issues) });
      await atomicNotamFile(join(this.directory, name), JSON.stringify(next));
      return { ...next, records: upgraded, issues };
    }
    this.remember(records, issues, { generation: manifest.generation, count: manifest.count, bytes: manifest.bytes });
    return { ...manifest, records, issues };
  }
  private async saveRecords(records: readonly NotamRecord[], issues: readonly NotamSourceIssue[]): Promise<Contents> {
    this.assertHeld();
    const saved = this.contents.get(records);
    if (saved?.issues === issues) return { generation: saved.generation, count: saved.count, bytes: saved.bytes };
    const temporary = join(this.directory, `${randomUUID()}.ndjson.tmp`), handle = await open(temporary, 'wx', 0o600);
    let bytes = 0, buffer = '', buffered = 0;
    const hash = createHash('sha256');
    try {
      for (const record of [...records, ...issues.map(issue => ({ kind: 'issue', issue }))]) {
        const line = JSON.stringify(record) + '\n', length = Buffer.byteLength(line); bytes += length;
        if (bytes > NOTAM_GENERATION_MAX_BYTES) throw new NotamError('dataset-size-limit');
        hash.update(line); buffer += line; buffered += length;
        if (buffered >= 256 * 1024) { await handle.writeFile(buffer); buffer = ''; buffered = 0; }
      }
      if (buffer) await handle.writeFile(buffer);
      await handle.sync();
      const generation = hash.digest('hex');
      await rename(temporary, join(this.directory, `${generation}.ndjson`));
      const result = { generation, bytes, count: records.length };
      this.remember(records, issues, result);
      return result;
    } catch (cause) { await rm(temporary, { force: true }); throw cause; }
    finally { await handle.close(); }
  }
  /** Reuse unchanged contents; only the small manifest advances on an empty delta. */
  async publish(value: Omit<NotamGeneration, 'generation'>, candidate = false): Promise<NotamGeneration> {
    this.assertHeld();
    const { records, issues = NO_NOTAM_ISSUES, ...metadata } = value;
    try {
      const manifest = sealManifest({ ...metadata, schemaVersion: 2, issueCount: issues.length, ...await this.saveRecords(records, issues) });
      this.assertHeld();
      if (candidate) {
        await atomicNotamFile(join(this.directory, 'candidate.json'), JSON.stringify(manifest));
        return { ...manifest, records, issues };
      }
      // Keep the preceding distinct dataset, not another manifest for the same file.
      if (this.manifest && this.manifest.generation !== manifest.generation) {
        await atomicNotamFile(join(this.directory, 'previous.json'), JSON.stringify(this.manifest));
      }
      await atomicNotamFile(join(this.directory, 'current.json'), JSON.stringify(manifest));
      this.manifest = manifest;
      await rm(join(this.directory, 'candidate.json'), { force: true });
      return { ...manifest, records, issues };
    } finally { await this.prune(); }
  }
  /** Only manifest references retain files. Never collect the quota journal or lock. */
  private async prune() {
    this.assertHeld();
    const retained = new Set<string>();
    for (const name of ['current.json', 'previous.json', 'candidate.json']) {
      try {
        const value = await readMetadata(join(this.directory, name));
        if (isRecord(value) && typeof value.generation === 'string' && /^[a-f0-9]{64}$/.test(value.generation)) retained.add(value.generation);
      } catch (cause) {
        if (!(cause instanceof SyntaxError) && (cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
    }
    for (const name of await readdir(this.directory)) {
      if (/^[a-f0-9]{64}\.ndjson$/.test(name) && !retained.has(name.slice(0, -7))) {
        await rm(join(this.directory, name), { force: true });
      }
    }
    for (const [records, saved] of this.contents) if (!retained.has(saved.generation)) this.contents.delete(records);
  }
  async close() { await this.budgetWrite; const lock = this.lock; this.lock = undefined; await lock?.release(); }
}
