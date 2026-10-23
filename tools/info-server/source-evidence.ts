import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicStateFile, readStateJson } from './state-file';

export type SourceEvidence = { source: string; requestedAt: number; checkedAt: number;
  headers: Record<string, string>; phase: 'download-validation' | 'member-adaptation' | 'catalog-validation'; rule: string };
/** Private, bounded exact-download evidence. Serial writes avoid competing
 * retention sweeps; failed diagnostics never replace the source failure. */
export function createSourceEvidence(directory: string, options: { sourceUrl?: string; log?: (message: string) => void } = {}) {
  const root = join(directory, 'source-failures');
  let pending: Promise<void> = Promise.resolve(), admitted = 0;
  const capture = (body: Buffer, evidence: SourceEvidence): Promise<string | undefined> => {
    // At most two source readers plus two queued captures retain buffers.
    if (body.length > 4 * 1024 * 1024 || admitted >= 4) {
      options.log?.('Weather source evidence skipped: capture bound'); return Promise.resolve(undefined);
    }
    admitted++;
    const task = pending.then(async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const sha256 = createHash('sha256').update(body).digest('hex');
      const id = createHash('sha256').update(`${evidence.source}\n${sha256}\n${evidence.phase}`).digest('hex');
      const names = await readdir(root);
      for (const name of names.filter(name => /^[a-f0-9]{64}\.(?:bin\.tmp|json\.[a-f0-9-]{36}\.tmp)$/.test(name))) await rm(join(root, name), { force: true });
      // Manifest last: a crash cannot advertise incomplete bytes as evidence.
      try {
        await readStateJson(join(root, `${id}.json`));
        const path = join(root, `${id}.bin`);
        if ((await stat(path)).size === body.length && createHash('sha256').update(await readFile(path)).digest('hex') === sha256) return id;
      } catch (cause) { if (!(cause instanceof SyntaxError) && (cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
      const manifests = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
        try { return { name, at: Number((await readStateJson(join(root, name)) as { requestedAt?: unknown }).requestedAt) || 0 }; }
        catch { return { name, at: 0 }; }
      }));
      // Seven retained downloads; trim before writing the eighth. Remove orphans
      // from interrupted writes so crashes cannot defeat the disk bound.
      manifests.sort((a, b) => b.at - a.at);
      const retained = new Set(manifests.slice(0, 6).map(entry => entry.name.slice(0, -5)));
      for (const name of names.filter(name => /^[a-f0-9]{64}\.(?:json|bin)$/.test(name))) {
        if (!retained.has(name.split('.')[0]!)) await rm(join(root, name), { force: true });
      }
      const path = join(root, `${id}.bin`);
      const handle = await open(`${path}.tmp`, 'w', 0o600);
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      await rename(`${path}.tmp`, path);
      await atomicStateFile(join(root, `${id}.json`), JSON.stringify({ schemaVersion: 1, id, sha256, byteLength: body.length,
        ...evidence, rule: evidence.rule.slice(0, 300), releaseSource: options.sourceUrl ?? null }));
      options.log?.(`Weather source evidence ${id}: ${evidence.rule.slice(0, 300)}`);
      return id;
    }).catch(cause => {
      options.log?.(`Weather source evidence unavailable: ${(cause as NodeJS.ErrnoException).code ?? 'write-failed'}`);
      return undefined;
    }).finally(() => { admitted--; });
    pending = task.then(() => {});
    return task;
  };
  return { capture, close: () => pending };
}
