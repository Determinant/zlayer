import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseSync, Visitor } from 'vite';

// Check source ownership and execution boundaries without relying on barrel names
// alone: a data entry must also keep its transitive runtime imports free of UI.
const root = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(root, 'src');
type Dependency = { specifier: string; target?: string; runtime: boolean; lazy: boolean };
const graph = new Map<string, Dependency[]>();
const failures = new Set<string>();
const local = (file: string) => relative(root, file).replaceAll('\\', '/');

function scan(directory: string): void {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = resolve(directory, item.name);
    if (item.isDirectory()) { scan(file); continue; }
    if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue;
    const source = readFileSync(file, 'utf8');
    const parsed = parseSync(file, source);
    for (const error of parsed.errors) failures.add(`${local(file)}: ${error.message}`);
    const dependencies: Dependency[] = [];
    const add = (specifier: string, runtime = true, lazy = false) => {
      let target: string | undefined;
      if (specifier.startsWith('.')) {
        const path = resolve(dirname(file), specifier.split('?')[0]!);
        target = [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`, `${path}/index.tsx`,
          ...(path.endsWith('.js') ? [path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx'] : [])]
          .find(candidate => existsSync(candidate) && /\.(tsx?|json|css)$/.test(candidate));
        if (!target) failures.add(`${local(file)}: unresolved local dependency ${specifier}`);
      }
      dependencies.push({ specifier, ...(target ? { target } : {}), runtime, lazy });
    };
    new Visitor({
      Identifier(node) {
        if (local(file).startsWith('src/layers/') && ['localStorage', 'sessionStorage'].includes(node.name)) {
          failures.add(`${local(file)}: plugins use their core-managed storage scope, not browser storage globals`);
        }
      },
      MemberExpression(node) {
        if (local(file).startsWith('src/layers/') && node.computed && node.property.type === 'Literal' &&
          ['localStorage', 'sessionStorage'].includes(String(node.property.value))) {
          failures.add(`${local(file)}: plugins use their core-managed storage scope, not browser storage globals`);
        }
      },
      CallExpression(node) {
        const call = source.slice(node.callee.start, node.callee.end);
        if (local(file).startsWith('src/layers/') && /^(?:(?:globalThis|window|self)\.)?fetch$/.test(call)) {
          failures.add(`${local(file)}: plugins must use core fetchJson, transferFile or readManagedFile; direct fetch bypasses shared acquisition policy`);
        }
      },
      ImportDeclaration(node) {
        const typeOnly = node.importKind === 'type' || (node.specifiers.length > 0 &&
          node.specifiers.every(item => item.type === 'ImportSpecifier' && item.importKind === 'type'));
        add(node.source.value, !typeOnly);
        if (local(file).startsWith('src/layers/') && node.specifiers.some(item => item.type === 'ImportSpecifier' &&
          item.imported.type === 'Identifier' && item.imported.name === 'downloadFile')) {
          failures.add(`${local(file)}: plugins use transferFile; the low-level response writer belongs behind core acquisition`);
        }
        if (local(file).startsWith('src/layers/') && node.specifiers.some(item => item.type === 'ImportSpecifier' &&
          item.imported.type === 'Identifier' && ['uiRecord', 'readUiState', 'writeUiState', 'usePersistentState'].includes(item.imported.name))) {
          failures.add(`${local(file)}: plugin records must use their storage scope; unscoped UI persistence is reserved for the shell`);
        }
      },
      ExportNamedDeclaration(node) {
        if (!node.source) return;
        const typeOnly = node.exportKind === 'type' || (node.specifiers.length > 0 &&
          node.specifiers.every(item => item.exportKind === 'type'));
        add(node.source.value, !typeOnly);
      },
      ExportAllDeclaration(node) { add(node.source.value, node.exportKind !== 'type'); },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') add(node.source.value, true, true);
      },
      NewExpression(node) {
        const [path, base] = node.arguments;
        if (node.callee.type === 'Identifier' && node.callee.name === 'URL' && path?.type === 'Literal' &&
          typeof path.value === 'string' && base && source.slice(base.start, base.end) === 'import.meta.url') {
          // Worker/assets do not enter the synchronous page graph, but ownership applies.
          add(path.value, true, true);
        }
      },
    }).visit(parsed.program);
    graph.set(file, dependencies);
  }
}
scan(sourceRoot);

const workspaceData = new Set(['src/workspace/read-context.ts', 'src/workspace/catalog/catalog.ts',
  'src/workspace/catalog/feed.ts']);
const migrationOwners = new Map([
  ['src/offline/compatibility/legacy-plans.ts', 'src/offline/saved-plans.ts'],
  ['src/offline/compatibility/legacy-bundles.ts', 'src/offline/bundle-repository.ts'],
  ['src/offline/compatibility/legacy-supplements.ts', 'src/offline/supplement-catalog.ts'],
]);
for (const [file, dependencies] of graph) {
  const from = local(file);
  for (const { target } of dependencies) {
    if (!target) continue;
    const to = local(target);
    if (from.startsWith('src/layers/') && /^src\/layers\/[^/]+\/storage\.ts$/.test(to) &&
      from.split('/')[2] !== to.split('/')[2]) {
      failures.add(`${from} -> ${to}: a plugin cannot import another plugin's storage scope`);
    }
    if (from.startsWith('src/core/') && !to.startsWith('src/core/')) {
      failures.add(`${from} -> ${to}: core must not depend on application or feature modules`);
    }
    if (from.startsWith('src/layers/') && (to.startsWith('src/shell/') ||
      (to.startsWith('src/workspace/') && !workspaceData.has(to)))) {
      failures.add(`${from} -> ${to}: features may consume workspace read data, not composition`);
    }
    if (['src/workspace/map/runtime.ts', 'src/workspace/map/canvas.tsx', 'src/workspace/map/inputs.ts',
      'src/shell/layer-menu.tsx', 'src/shell/map-edge-tools.tsx'].includes(from) && to.startsWith('src/layers/')) {
      failures.add(`${from} -> ${to}: generic hosts consume contributions, not individual features`);
    }
    if (to.startsWith('src/offline/compatibility/') && !from.startsWith('src/offline/compatibility/') &&
      migrationOwners.get(to) !== from) {
      failures.add(`${from} -> ${to}: legacy migration belongs behind its persistence entry`);
    }
  }
}

function checkRuntime(entry: string, forbidden: RegExp, description: string, followLazy = true): void {
  const seen = new Set<string>();
  const visit = (file: string, trail: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dependency of graph.get(file) ?? []) {
      if (!dependency.runtime || (dependency.lazy && !followLazy)) continue;
      const next = [...trail, dependency.target ? local(dependency.target) : dependency.specifier];
      if (!dependency.target && forbidden.test(dependency.specifier)) {
        failures.add(`${description}: ${next.join(' -> ')}`);
      } else if (dependency.target) visit(dependency.target, next);
    }
  };
  visit(resolve(root, entry), [entry]);
}

const uiRuntime = /^(react(?:-dom)?|maplibre-gl|pdfjs-dist)(\/|$)/;
for (const file of graph.keys()) {
  const path = local(file);
  const dataEntry = /^src\/core\/(data|storage|gps)\//.test(path) ||
    (path.startsWith('src/offline/') && !path.includes('/use-')) ||
    /^src\/layers\/[^/]+\/(api|definitions|offline)\.ts$/.test(path) ||
    workspaceData.has(path);
  const workerEntry = path === 'src/service-worker.ts' || /(?:\.worker|-worker)\.ts$/.test(path);
  if (dataEntry || workerEntry) checkRuntime(path, uiRuntime, 'Data/worker entry imports a UI runtime');
}
checkRuntime('src/main.tsx', /^(maplibre-gl|pdfjs-dist|sql\.js|sql\.js-httpvfs)(\/|$)/,
  'Initial page imports a lazy renderer/decoder', false);

if (failures.size) {
  console.error([...failures].sort().join('\n'));
  process.exitCode = 1;
} else console.log(`Import boundaries passed (${graph.size} source modules).`);
