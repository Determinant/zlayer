import type { Plugin } from 'vite';

/** Only the opt-in fixture build installs this instrumentation. Fail closed when
 * a measured function changes, rather than silently reporting zero work. */
export function renderingBenchmark(): Plugin {
  const targets: Record<string, [string, string, boolean][]> = {
    '/src/layers/charts/mbtiles-protocol.ts': [['readTile', 'tile', false]],
    '/src/layers/charts/package-loader.ts': [['openPackageReader', 'package-open', true]],
    '/src/core/storage/file-transfer.ts': [['readManagedFile', 'managed-file-read', true]],
    '/src/layers/charts/package-reader.ts': [['createPackageReader', 'package-resident', true]],
    '/src/offline/region-coverage.ts': [['partitionRegionCoverage', 'partition', true]],
    '/src/layers/charts/regional-tiles.ts': [['renderRegionalTile', 'regional', true]],
    '/src/core/graphics/raster-bitmap.ts': [['renderRasterBitmap', 'composition', true]],
  };
  const seen = new Set<string>();
  return {
    name: 'zlayer-rendering-benchmark', enforce: 'pre', apply: 'build',
    transform(code, id) {
      const path = Object.keys(targets).find(path => id.endsWith(path));
      const runtime = id.endsWith('/src/workspace/map/runtime.ts');
      if (!path && !runtime) return;
      seen.add(path ?? 'runtime');
      code = `import { renderingProbe as __renderProbe } from '${new URL('./rendering-benchmark-probe.ts', import.meta.url).pathname}';\n${code}`;
      if (runtime) {
        const marker = 'const { onIdleChange } = options;';
        if (code.split(marker).length !== 2) throw new Error('Rendering benchmark map hook changed');
        code = code.replace(marker, `__renderProbe.attach(this.#map);\n${marker}`);
      }
      if (path === '/src/layers/charts/package-loader.ts') {
        const call = 'client.call<PackageTile[]>(remote => remote.decode(transfer(bytes, [bytes])))';
        if (code.split(call).length !== 2) throw new Error('Rendering benchmark decoder hook changed');
        code = code.replace(call, `__renderProbe.measure('package-decode', [], () => ${call})`);
      }
      for (const [name, metric, exported] of targets[path ?? ''] ?? []) {
        const declaration = new RegExp(`${exported ? 'export ' : ''}(async )?function ${name}\\(`, 'g');
        if ([...code.matchAll(declaration)].length !== 1) throw new Error(`Rendering benchmark hook changed: ${name}`);
        code = code.replace(declaration, `$1function ${name}Measured(`);
        code += `\n${exported ? 'export ' : ''}function ${name}(...args: Parameters<typeof ${name}Measured>): ReturnType<typeof ${name}Measured> {
          return __renderProbe.measure('${metric}', args, () => ${name}Measured(...args));
        }\n`;
      }
      return { code, map: null };
    },
    buildEnd(error) {
      if (!error && seen.size !== Object.keys(targets).length + 1) throw new Error('Rendering benchmark hooks missing');
    },
  };
}
