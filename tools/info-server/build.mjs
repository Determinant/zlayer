import { build } from 'vite';
import { copyFile, writeFile } from 'node:fs/promises';

// Bundle the gateway and its CPU workers. Enabled NMS also needs Linux flock.
await build({ configFile: false, publicDir: false, logLevel: 'warn', ssr: { noExternal: true },
  build: { ssr: true, outDir: 'tools/info-server/dist', emptyOutDir: true,
    rolldownOptions: { input: { main: 'tools/info-server/main.ts', server: 'tools/info-server/server.ts', worker: 'tools/info-server/worker.ts',
      'radar-worker': 'tools/info-server/radar-worker.ts', 'progs-worker': 'tools/info-server/progs-worker.ts',
      'progs-coverage-worker': 'tools/info-server/progs-coverage-worker.ts',
      'notams-worker': 'tools/info-server/notams-worker.ts', 'check-info-api': 'tools/check-info-api.ts' },
      output: { entryFileNames: '[name].js', chunkFileNames: 'shared-[hash].js' } } } });

await writeFile('tools/info-server/dist/package.json', JSON.stringify({ private: true, type: 'module' }) + '\n');
await copyFile('tools/info-server/vendor/seek-bzip/LICENSE', 'tools/info-server/dist/seek-bzip.LICENSE');
