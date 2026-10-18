import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Embed core CSS and fonts so the status page works without the PWA or asset routes. */
export function loadStatusStyles(): string {
  function css(url: URL): string {
    return readFileSync(url, 'utf8').replace(/@import ['"]([^'"]+)['"];\s*/g,
      (_, path: string) => css(new URL(path, url)));
  }
  const require = createRequire(import.meta.url);
  const fonts = [400, 700].map(weight => {
    const data = readFileSync(require.resolve(`@fontsource/b612/files/b612-latin-${weight}-normal.woff2`)).toString('base64');
    return `@font-face{font-family:B612;font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${data}) format('woff2')}`;
  }).join('\n');
  const core = css(new URL('../../src/core/ui/styles.css', import.meta.url))
    .replace(/:root\[data-theme="light"\] \{([^}]+)\}/, '@media(prefers-color-scheme:light){:root{$1}}');
  return fonts + '\n' + core;
}
