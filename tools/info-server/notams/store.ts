import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isRecord, isNotamRecord, type NotamRecord, type NotamEnvironment, NOTAM_REFRESH_MS } from '@zlayer/contracts';
import { acquireNotamLock } from './lock';
import { NotamError } from './error';
import { upgradeNotamRecord } from './normalize';
import type { NotamRevisionConflict } from './revision';

export const NOTAM_DAY_MS = 86_400_000;
export const NOTAM_GENERATION_MAX_BYTES = 256 * 1024 * 1024;
export type NotamGeneration = { schemaVersion: 1; environment: NotamEnvironment; generation: string;
  checkedAt: number; watermark: number; fullSyncAt: number; baselineAt: number; complete: boolean;
  incompleteReason?: string; records: readonly NotamRecord[] };
type Manifest = Omit<NotamGeneration, 'records'> & { count: number; bytes: number };
type Contents = Pick<Manifest, 'generation' | 'count' | 'bytes'>;
type Journal = { schemaVersion: 1; environment: NotamEnvironment; lastAttemptAt: number; dataAt: number; bulkAt: number; anyAt: number; backoffAt: number };
const instant = (v: unknown): v is number => Number.isSafeInteger(v) && typeof v === 'number' && v >= 0;

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
  private manifest: Manifest | undefined;
  private readonly contents = new Map<readonly NotamRecord[], Contents>();
  recoveryError: 'invalid-checkpoint' | undefined;
  constructor(readonly directory: string, readonly environment: NotamEnvironment, private readonly now = Date.now) {}
  get nextDataAt() { return Math.max(this.journal?.dataAt ?? 0, this.journal?.backoffAt ?? 0); }
  get nextBulkAt() { return Math.max(this.nextDataAt, this.journal?.bulkAt ?? 0); }
  get nextAnyAt() { return Math.max(this.journal?.anyAt ?? 0, this.journal?.backoffAt ?? 0); }
  private async saveJournal(journal: Journal) {
    this.assertHeld();
    await atomicNotamFile(join(this.directory, 'budget.json'), JSON.stringify(journal));
    this.journal = journal;
  }
  private assertHeld() {
    if (!this.lock) throw new NotamError('storage-unavailable');
    this.lock.assertHeld();
  }
  private remember(records: readonly NotamRecord[], contents: Contents) {
    for (const [old, saved] of this.contents) if (saved.generation === contents.generation) this.contents.delete(old);
    this.contents.set(records, contents);
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
      await this.saveJournal({ schemaVersion: 1, environment: this.environment, lastAttemptAt: 0, dataAt: 0, bulkAt: 0, anyAt: 0, backoffAt: 0 });
    } else {
      let value: unknown;
      try { value = JSON.parse(await readFile(join(this.directory, 'budget.json'), 'utf8')); }
      catch { throw new NotamError('invalid-budget'); }
      if (!isRecord(value) || value.schemaVersion !== 1 || value.environment !== this.environment ||
        !['lastAttemptAt', 'dataAt', 'bulkAt', 'anyAt', 'backoffAt'].every(k => instant(value[k]))) throw new NotamError('invalid-budget');
      this.journal = value as Journal;
    }
    // Only the lock owner may discard private, interrupted writes.
    for (const name of await readdir(this.directory)) if (name.endsWith('.tmp')) await rm(join(this.directory, name), { force: true });
    await this.prune();
    let damaged = false;
    for (const name of ['current.json', 'previous.json']) {
      let found = false;
      try {
        const manifest: unknown = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
        found = true;
        const generation = await this.readGeneration(manifest, name);
        const { records: _records, ...metadata } = generation;
        this.manifest = { ...metadata, ...this.contents.get(generation.records)! };
        if (damaged) { generation.complete = false; this.recoveryError = 'invalid-checkpoint'; }
        return generation;
      } catch (error) {
        if (found || (error as NodeJS.ErrnoException).code !== 'ENOENT') damaged = true;
      }
    }
    if (damaged) this.recoveryError = 'invalid-checkpoint';
    return undefined;
  }
  async reserve(kind: 'bulk' | 'delta' | 'auth' | 'content'): Promise<void> {
    if (!this.journal) throw new NotamError('storage-unavailable');
    const now = this.now(), due = Math.max(this.nextAnyAt, kind === 'bulk' ? this.nextBulkAt : kind === 'delta' ? this.nextDataAt : 0);
    if (now < due || now < this.journal.lastAttemptAt) throw new NotamError('request-budget', Math.max(due, this.journal.lastAttemptAt));
    await this.saveJournal({ ...this.journal, lastAttemptAt: now, anyAt: now + 1000,
      ...(['bulk', 'delta'].includes(kind) ? { dataAt: now + NOTAM_REFRESH_MS } : {}),
      ...(kind === 'bulk' ? { bulkAt: now + NOTAM_DAY_MS } : {}) });
  }
  async backoff(until: number) {
    if (!this.journal) throw new NotamError('storage-unavailable');
    await this.saveJournal({ ...this.journal, backoffAt: Math.max(this.journal.backoffAt, until) });
  }
  async restoreCandidate(): Promise<NotamGeneration | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory, 'candidate.json'), 'utf8'));
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
      const value: unknown = JSON.parse(await readFile(join(this.directory, 'previous.json'), 'utf8'));
      const previous = await this.readGeneration(value, 'previous.json');
      return previous.complete ? previous : undefined;
    } catch { return undefined; /* Only an authenticated complete checkpoint can seed replay. */ }
  }
  async recordConflict(conflict: NotamRevisionConflict) {
    this.assertHeld();
    const summary = { schemaVersion: 1, environment: this.environment, detectedAt: this.now(),
      id: conflict.next.id, fields: conflict.fields, previousRevision: conflict.previous.revision, nextRevision: conflict.next.revision };
    const details = JSON.stringify({ ...summary, previous: conflict.previous, next: conflict.next });
    // One private diagnostic, never part of an airport response or a source archive.
    await atomicNotamFile(join(this.directory, 'conflict.json'), Buffer.byteLength(details) <= 8 * 1024 * 1024
      ? details : JSON.stringify({ ...summary, recordsOmitted: true }));
  }
  async invalidate(reason: string) {
    this.assertHeld();
    if (!this.manifest) return;
    // The rejected delta never changed this verified prefix. Retain its exact
    // boundary for a complete replay; the visible current state stays incomplete.
    if (this.manifest.complete) await atomicNotamFile(join(this.directory, 'previous.json'), JSON.stringify(this.manifest));
    const manifest = { ...this.manifest, complete: false, incompleteReason: reason };
    await atomicNotamFile(join(this.directory, 'current.json'), JSON.stringify(manifest));
    this.manifest = manifest;
  }
  private async readGeneration(value: unknown, name: string): Promise<NotamGeneration> {
    if (!isRecord(value) || value.schemaVersion !== 1 || value.environment !== this.environment ||
      typeof value.generation !== 'string' || !/^[a-f0-9]{64}$/.test(value.generation) || typeof value.complete !== 'boolean' ||
      value.incompleteReason !== undefined && (typeof value.incompleteReason !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.incompleteReason)) ||
      !['checkedAt', 'watermark', 'fullSyncAt', 'baselineAt', 'bytes', 'count'].every(k => instant(value[k])) ||
      Number(value.bytes) > NOTAM_GENERATION_MAX_BYTES || Number(value.count) > 150_000 || Number(value.watermark) > this.now()) {
      throw new NotamError('invalid-checkpoint');
    }
    const manifest = value as Manifest, path = join(this.directory, `${manifest.generation}.ndjson`);
    if ((await stat(path)).size !== manifest.bytes) throw new NotamError('invalid-checkpoint');
    const hash = createHash('sha256'), records: NotamRecord[] = [], ids = new Set<string>();
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    try { for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (line.length > 3 * 1024 * 1024) throw new NotamError('invalid-checkpoint');
      const record: unknown = JSON.parse(line);
      if (!isNotamRecord(record) || ids.has(record.id)) throw new NotamError('invalid-checkpoint');
      ids.add(record.id); records.push(record);
      if (records.length > manifest.count) throw new NotamError('invalid-checkpoint');
    } } finally { stream.destroy(); }
    if (records.length !== manifest.count || hash.digest('hex') !== manifest.generation) throw new NotamError('invalid-checkpoint');
    const upgraded = records.map(upgradeNotamRecord);
    if (upgraded.some((record, index) => record !== records[index])) {
      const next = { ...manifest, ...await this.saveRecords(upgraded) };
      await atomicNotamFile(join(this.directory, name), JSON.stringify(next));
      return { ...next, records: upgraded };
    }
    this.remember(records, { generation: manifest.generation, count: manifest.count, bytes: manifest.bytes });
    return { ...manifest, records };
  }
  private async saveRecords(records: readonly NotamRecord[]): Promise<Contents> {
    this.assertHeld();
    const saved = this.contents.get(records);
    if (saved) return saved;
    const temporary = join(this.directory, `${randomUUID()}.ndjson.tmp`), handle = await open(temporary, 'wx', 0o600);
    let bytes = 0, buffer = '', buffered = 0;
    const hash = createHash('sha256');
    try {
      for (const record of records) {
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
      this.remember(records, result);
      return result;
    } catch (cause) { await rm(temporary, { force: true }); throw cause; }
    finally { await handle.close(); }
  }
  /** Reuse unchanged contents; only the small manifest advances on an empty delta. */
  async publish(value: Omit<NotamGeneration, 'generation'>, candidate = false): Promise<NotamGeneration> {
    this.assertHeld();
    const { records, ...metadata } = value;
    try {
      const manifest: Manifest = { ...metadata, ...await this.saveRecords(records) };
      this.assertHeld();
      if (candidate) {
        await atomicNotamFile(join(this.directory, 'candidate.json'), JSON.stringify(manifest));
        return { ...manifest, records };
      }
      // Keep the preceding distinct dataset, not another manifest for the same file.
      if (this.manifest && this.manifest.generation !== manifest.generation) {
        await atomicNotamFile(join(this.directory, 'previous.json'), JSON.stringify(this.manifest));
      }
      await atomicNotamFile(join(this.directory, 'current.json'), JSON.stringify(manifest));
      this.manifest = manifest;
      await rm(join(this.directory, 'candidate.json'), { force: true });
      return { ...manifest, records };
    } finally { await this.prune(); }
  }
  /** Only manifest references retain files. Never collect the quota journal or lock. */
  private async prune() {
    this.assertHeld();
    const retained = new Set<string>();
    for (const name of ['current.json', 'previous.json', 'candidate.json']) {
      try {
        const value: unknown = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
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
  async close() { const lock = this.lock; this.lock = undefined; await lock?.release(); }
}
