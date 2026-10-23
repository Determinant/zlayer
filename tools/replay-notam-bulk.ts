import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readArchivedNotamBulk } from './info-server/notams/bulk-source';
import { NOTAM_BULK_PARSE_MS } from './info-server/notams/policy';
import { workerJob } from './info-server/worker-job';
import type { NotamMemberRejection } from './info-server/notams/normalize';

/** Parse preserved bytes into a new debug directory. No collector, credentials,
 * network acquisition, state publication or admission journal is opened. */
export async function replayNotamBulk(archivePath: string, outputDirectory: string, signal = new AbortController().signal) {
  const source = await readArchivedNotamBulk(resolve(archivePath));
  const directory = resolve(outputDirectory);
  await mkdir(directory, { mode: 0o700 }); // Existing output is never overwritten.
  const output = join(directory, 'records.ndjson'), started = performance.now();
  const worker = new URL(import.meta.url.endsWith('.ts') ? './info-server/notams-worker.ts' : './notams-worker.js', import.meta.url);
  try {
    const parsed = await workerJob<{ snapshotAt: number; count: number; bytes: number; rejected: NotamMemberRejection[] }>(worker,
      { path: source.path, output, kind: source.kind ?? 'bulk', requestedAt: source.requestedAt }, signal, [], NOTAM_BULK_PARSE_MS);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(output)) { hash.update(chunk); bytes += chunk.length; }
    if (bytes !== parsed.bytes) throw new Error('Replay output length mismatch');
    const result = { outcome: parsed.rejected.length ? 'partial' as const : 'parsed' as const, source, ...parsed,
      normalizedSha256: hash.digest('hex'), elapsedMs: performance.now() - started };
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } catch (cause) {
    await writeFile(join(directory, 'result.json'), JSON.stringify({ outcome: 'failed', source,
      error: cause instanceof Error ? cause.message : String(cause), elapsedMs: performance.now() - started }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    throw cause;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [archive, directory, ...extra] = process.argv.slice(2);
  if (!archive || !directory || extra.length) throw new Error('Usage: replay-notam-bulk <archive.json> <new-output-directory>');
  console.log(JSON.stringify(await replayNotamBulk(archive, directory)));
}
