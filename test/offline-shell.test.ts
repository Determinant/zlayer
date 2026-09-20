import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { offlineShell } from '../tools/offline-shell';

test('built page and worker share a reproducible version that changes with source or commit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zlayer-version-'));
  const originalCommit = process.env.ZLAYER_GIT_COMMIT;
  t.after(async () => {
    if (originalCommit === undefined) delete process.env.ZLAYER_GIT_COMMIT;
    else process.env.ZLAYER_GIT_COMMIT = originalCommit;
    await rm(root, { recursive: true, force: true });
  });
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  process.env.ZLAYER_GIT_COMMIT = 'A'.repeat(40);
  await writeFile(join(root, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>');
  await writeFile(join(root, 'main.js'), 'console.log("first build");');
  await writeFile(join(root, 'sw.js'), 'globalThis.shellDefinition = "__ZLAYER_OFFLINE_SHELL__";');

  const compile = async () => {
    const result = await build({ root, configFile: false, publicDir: false, logLevel: 'silent', plugins: [offlineShell()],
      build: { write: false, rolldownOptions: {
        input: { app: join(root, 'index.html'), sw: join(root, 'sw.js') },
        output: { entryFileNames: chunk => chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js' },
      } },
    });
    assert(!Array.isArray(result) && 'output' in result);
    const html = result.output.find(file => file.fileName === 'index.html');
    const worker = result.output.find(file => file.fileName === 'sw.js');
    assert(html?.type === 'asset' && worker?.type === 'chunk');
    const markup = String(html.source);
    const release = /name="zlayer-release" content="([a-f0-9]{16})"/.exec(markup)?.[1];
    const displayVersion = /name="zlayer-version" content="([^"]+)"/.exec(markup)?.[1];
    assert(release && displayVersion);
    const context = { shellDefinition: '' };
    runInNewContext(worker.code, context);
    const shell = JSON.parse(context.shellDefinition);
    assert.equal(shell.version, release);
    assert.equal(shell.displayVersion, displayVersion);
    assert(shell.assets.includes('/'));
    return { release, displayVersion };
  };

  const first = await compile();
  assert.equal(first.displayVersion, `v${version}+gaaaaaaa.b${first.release.slice(0, 8)}`);
  assert.deepEqual(await compile(), first, 'identical input gives a stable build hash');
  await writeFile(join(root, 'main.js'), 'console.log("uncommitted change");');
  const modified = await compile();
  assert.notEqual(modified.release, first.release, 'uncommitted app changes alter the build hash');
  assert.equal(modified.displayVersion, `v${version}+gaaaaaaa.b${modified.release.slice(0, 8)}`);
  process.env.ZLAYER_GIT_COMMIT = 'aaaaaaa' + 'b'.repeat(33);
  const committed = await compile();
  assert.notEqual(committed.release, modified.release, 'even a commit with the same short prefix has a distinct internal ID');
  assert.equal(committed.displayVersion, `v${version}+gaaaaaaa.b${committed.release.slice(0, 8)}`);
});
