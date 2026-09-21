import { openAsBlob } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/** Real disk-backed Blobs, with controllable writes for backpressure/failure tests. */
export async function fileStorageFixture(t: TestContext) {
  const rootPath = await mkdtemp(join(tmpdir(), 'zlayer-download-test-'));
  const fixture = { writes: [] as number[], beforeWrite: async (_bytes: Uint8Array) => {}, aborts: 0 };
  async function present(path: string) {
    try { await stat(path); } catch { throw new DOMException('Missing', 'NotFoundError'); }
  }
  const directory = (path: string): FileSystemDirectoryHandle => ({
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      const next = join(path, name);
      if (options?.create) await mkdir(next, { recursive: true });
      else await present(next);
      return directory(next);
    },
    async *keys() { yield* await readdir(path); },
    async removeEntry(name: string, options?: { recursive?: boolean }) {
      await present(join(path, name));
      await rm(join(path, name), { recursive: options?.recursive ?? false });
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      const filePath = join(path, name);
      if (options?.create) await (await open(filePath, 'a')).close();
      else await present(filePath);
      return {
        getFile: async () => openAsBlob(filePath),
        async createWritable() {
          const handle = await open(filePath, 'w');
          return {
            async write(bytes: Uint8Array) {
              fixture.writes.push(bytes.byteLength);
              await fixture.beforeWrite(bytes);
              await handle.write(bytes);
            },
            close: () => handle.close(),
            abort: async () => { fixture.aborts++; await handle.close(); },
          };
        },
      };
    },
  }) as unknown as FileSystemDirectoryHandle;
  const storage = { getDirectory: async () => directory(rootPath) } as StorageManager;
  const original = Object.getOwnPropertyDescriptor(navigator, 'storage');
  Object.defineProperty(navigator, 'storage', { configurable: true, value: storage });
  t.after(async () => {
    if (original) Object.defineProperty(navigator, 'storage', original);
    else Reflect.deleteProperty(navigator, 'storage');
    await rm(rootPath, { recursive: true, force: true });
  });
  return { ...fixture, storage, fixture,
    files: async () => readdir(join(rootPath, 'zlayer-downloads')).catch(() => [] as string[]),
  };
}
