import { build } from 'vite';
import { writeFile } from 'node:fs/promises';

// Bundle the gateway and its CPU workers. Production needs only Node.
await build({ configFile: false, publicDir: false, logLevel: 'warn', ssr: { noExternal: true },
  build: { ssr: true, outDir: 'tools/weather-server/dist', emptyOutDir: true,
    rolldownOptions: { input: { main: 'tools/weather-server/main.ts', worker: 'tools/weather-server/worker.ts',
      'radar-worker': 'tools/weather-server/radar-worker.ts', 'progs-worker': 'tools/weather-server/progs-worker.ts',
      'progs-coverage-worker': 'tools/weather-server/progs-coverage-worker.ts' },
      output: { entryFileNames: '[name].js', chunkFileNames: 'shared-[hash].js' } } } });

await writeFile('tools/weather-server/dist/package.json', JSON.stringify({ private: true, type: 'module' }) + '\n');
