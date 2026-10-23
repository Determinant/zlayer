import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isRecord } from '@zlayer/contracts';
import { atomicStateFile, readStateJson } from '../state-file';
import { NotamError } from './error';
import { NOTAM_DAY_MS } from './policy';
import type { NotamStore } from './store';

const MAX_BYTES = 64 * 1024 * 1024;
const ARCHIVE_COUNT = 7;
const sourceName = /^bulk-source-[a-f0-9]{64}\.bin$/;
const archiveName = /^(\d{1,16}-[a-f0-9]{64})\.(bin|json)$/;
const archiveTemporary = /^\d{1,16}-[a-f0-9]{64}\.json\.[a-f0-9-]+\.tmp$/;
type Manifest = { schemaVersion: 1; environment: string; requestedAt: number; bytes: number; sha256: string };
type ArchivedManifest = Manifest & { sourceUrl: string | null; kind?: 'delta'; reason?: string };
export type SavedNotamBulk = Manifest & { path: string };
const seal = (value: Manifest) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fingerprint(path: string) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new NotamError('invalid-bulk-source');
    hash.update(chunk);
  }
  if (!bytes) throw new NotamError('invalid-bulk-source');
  return { bytes, sha256: hash.digest('hex') };
}
function manifest(input: unknown): Manifest {
  if (!isRecord(input)) throw new NotamError('invalid-bulk-source');
  const { checksum, ...value } = input;
  if (value.schemaVersion !== 1 || typeof value.environment !== 'string' || !['production', 'staging'].includes(value.environment) ||
    typeof value.requestedAt !== 'number' || !Number.isSafeInteger(value.requestedAt) || value.requestedAt < 0 ||
    typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_BYTES ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || checksum !== seal(value as Manifest)) {
    throw new NotamError('invalid-bulk-source');
  }
  return value as Manifest;
}

/** Offline inspection only: this never restores a collector or admission journal. */
export async function readArchivedNotamBulk(path: string): Promise<ArchivedManifest & { path: string }> {
  const value = manifest(await readStateJson(path)) as ArchivedManifest;
  if (value.sourceUrl !== null && (typeof value.sourceUrl !== 'string' || value.sourceUrl.length > 8192) ||
    value.kind !== undefined && value.kind !== 'delta' ||
    value.reason !== undefined && (typeof value.reason !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.reason)) ||
    basename(path) !== `${value.requestedAt}-${value.sha256}.json`) throw new NotamError('invalid-bulk-source');
  const source = join(dirname(path), `${value.requestedAt}-${value.sha256}.bin`), actual = await fingerprint(source);
  if (actual.bytes !== value.bytes || actual.sha256 !== value.sha256) throw new NotamError('invalid-bulk-source');
  return { ...value, path: source };
}

/** One recovery checkpoint plus seven private diagnostic downloads. Neither grants admission. */
export class NotamBulkSource {
  private readonly manifestPath: string;
  private readonly archiveDirectory: string;
  constructor(private readonly store: NotamStore, private readonly now = Date.now, private readonly sourceUrl?: string) {
    this.manifestPath = join(store.directory, 'bulk-source.json');
    this.archiveDirectory = join(store.directory, 'bulk-archive');
  }
  private async pruneArchive(directory = this.archiveDirectory) {
    this.store.assertHeld();
    let names: string[];
    try { names = await readdir(directory); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause; }
    const committed = names.filter(name => archiveName.test(name) && name.endsWith('.json'))
      .map(name => name.slice(0, -5)).sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]) || b.localeCompare(a));
    const keep = new Set(committed.slice(0, ARCHIVE_COUNT));
    for (const name of names) {
      const match = archiveName.exec(name);
      if (match && !keep.has(match[1]!) || archiveTemporary.test(name)) await rm(join(directory, name), { force: true });
    }
  }
  private async archive(saved: SavedNotamBulk, sourceUrl: string | null, failure?: { kind: 'delta'; reason: string }) {
    this.store.assertHeld();
    const directory = failure ? join(this.store.directory, 'delta-failures') : this.archiveDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const { path, ...value } = saved, stem = `${value.requestedAt}-${value.sha256}`;
    const destination = join(directory, `${stem}.bin`), metadata = join(directory, `${stem}.json`);
    // Both paths stay on the durable state filesystem. Unlinking the replay
    // checkpoint cannot remove the archived bytes, and no copy doubles disk use.
    try { await link(path, destination); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      const actual = await fingerprint(destination);
      if (actual.bytes !== value.bytes || actual.sha256 !== value.sha256) throw new NotamError('invalid-bulk-source');
    }
    try {
      const previous = manifest(await readStateJson(metadata));
      if (previous.environment !== value.environment || previous.requestedAt !== value.requestedAt ||
        previous.bytes !== value.bytes || previous.sha256 !== value.sha256) throw new NotamError('invalid-bulk-source');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      const archived: ArchivedManifest = { ...value, sourceUrl, ...failure };
      // Commit metadata after the raw link; this also fsyncs their directory.
      await atomicStateFile(metadata, JSON.stringify({ ...archived, checksum: seal(archived) }));
    }
    // Also commit the archive directory's entry before a rejected input can
    // retire its root-level recovery checkpoint.
    const parent = await open(this.store.directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    await this.pruneArchive(directory);
  }
  /** Diagnostic only: failed deltas never become a baseline or grant admission. */
  async saveDeltaFailure(path: string, requestedAt: number, reason: string) {
    this.store.assertHeld();
    const content = await fingerprint(path);
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await this.archive({ schemaVersion: 1, environment: this.store.environment, requestedAt, ...content, path },
      this.sourceUrl ?? null, { kind: 'delta', reason });
  }
  private async prune(keep?: string) {
    this.store.assertHeld();
    for (const name of await readdir(this.store.directory)) {
      if (sourceName.test(name) && name !== keep) await rm(join(this.store.directory, name), { force: true });
    }
  }
  async save(path: string, requestedAt: number): Promise<SavedNotamBulk> {
    this.store.assertHeld();
    const content = await fingerprint(path);
    const value: Manifest = { schemaVersion: 1, environment: this.store.environment, requestedAt, ...content };
    const name = `bulk-source-${value.sha256}.bin`, destination = join(this.store.directory, name);
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(path, destination);
    // The atomic manifest fsyncs the directory, committing the source rename too.
    await atomicStateFile(this.manifestPath, JSON.stringify({ ...value, checksum: seal(value) }));
    this.store.assertHeld();
    await this.archive({ ...value, path: destination }, this.sourceUrl ?? null);
    await this.prune(name);
    return { ...value, path: destination };
  }
  async restore(fullSyncAt: number | null): Promise<SavedNotamBulk | undefined> {
    this.store.assertHeld();
    await this.pruneArchive(join(this.store.directory, 'delta-failures'));
    let input: unknown;
    try { input = await readStateJson(this.manifestPath); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') { await this.prune(); await this.pruneArchive(); return; }
      throw new NotamError('invalid-bulk-source');
    }
    const value = manifest(input);
    if (value.environment !== this.store.environment) throw new NotamError('invalid-bulk-source');
    const name = `bulk-source-${value.sha256}.bin`, path = join(this.store.directory, name);
    try {
      const actual = await fingerprint(path);
      if (actual.bytes !== value.bytes || actual.sha256 !== value.sha256) throw new Error();
    } catch { throw new NotamError('invalid-bulk-source'); }
    // Legacy recovery files have no acquisition-release identity. Preserve it
    // as unknown; an existing archive retains the release recorded at download.
    await this.archive({ ...value, path }, null);
    // Download time is never substituted for the XML snapshot boundary. The
    // parser and delta bridge still validate that boundary before publication.
    if (value.requestedAt > this.now() || this.now() - value.requestedAt >= NOTAM_DAY_MS ||
      fullSyncAt !== null && value.requestedAt <= fullSyncAt) {
      await this.discard(); return;
    }
    await this.prune(name);
    return { ...value, path };
  }
  async discard() {
    this.store.assertHeld();
    await rm(this.manifestPath, { force: true });
    await this.prune();
  }
}
