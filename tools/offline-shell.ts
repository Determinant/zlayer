import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { readBuildIdentity } from './build-version.ts';

/** Include lazy viewers, workers, WASM and fonts, not just the entry HTML's links. */
export function offlineShell(): Plugin {
  return {
    name: 'zlayer-offline-shell',
    apply: 'build',
    // Vite removes temporary CSS-only JavaScript chunks during generateBundle.
    // Snapshot the final outputs so addAll never requests a discarded chunk.
    generateBundle: { order: 'post', handler(_options, bundle) {
      const identity = readBuildIdentity();
      const worker = bundle['sw.js'];
      if (!worker || worker.type !== 'chunk') throw new Error('Missing offline service worker');
      const publicAssets = ['manifest.webmanifest', 'icon.svg', 'logo.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
        'fonts/Noto Sans Bold/0-255.pbf'];
      const assets = ['/', ...publicAssets.map(path => `/${encodeURI(path)}`), ...Object.keys(bundle)
        .filter(path => path.startsWith('assets/')).sort().map(path => `/${path}`)];
      const html = bundle['index.html'];
      const hash = createHash('sha256').update(JSON.stringify(identity)).update(JSON.stringify(assets)).update(worker.code)
        .update(html?.type === 'asset' ? html.source : '');
      for (const path of publicAssets) hash.update(readFileSync(new URL(`../public/${path}`, import.meta.url)));
      const version = hash.digest('hex').slice(0, 16);
      const displayVersion = `v${identity.version}+g${identity.commit.slice(0, 7)}.b${version.slice(0, 8)}`;
      // Identify the document actually running, even after a newer worker takes
      // control. Inject after hashing to avoid a self-referential release hash.
      if (!html || html.type !== 'asset') throw new Error('Missing application HTML');
      const markup = typeof html.source === 'string' ? html.source : Buffer.from(html.source).toString('utf8');
      html.source = markup.replace('</head>', `<meta name="zlayer-release" content="${version}" />` +
        `<meta name="zlayer-version" content="${displayVersion}" /></head>`);
      const marker = '__ZLAYER_OFFLINE_SHELL__';
      if (!worker.code.includes(marker)) throw new Error('Missing offline shell marker');
      worker.code = worker.code.replace(marker, JSON.stringify({ version, displayVersion, assets }).replaceAll('"', '\\"'));
    } },
  };
}
