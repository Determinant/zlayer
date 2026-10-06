import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function readStateJson(path: string, maxBytes = 16 * 1024): Promise<unknown> {
  const handle = await open(path, 'r');
  try {
    if ((await handle.stat()).size > maxBytes) throw new SyntaxError('State metadata size limit');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

export async function atomicStateFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    const directory = await open(join(path, '..'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (cause) { await rm(temporary, { force: true }).catch(() => {}); throw cause; }
}
