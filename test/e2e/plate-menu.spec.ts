import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let origin: string;
let cacheDirectory: string | undefined;

// Production React skips StrictMode's effect replay. Exercise the development
// runtime too: restoring focus during that replay must not dismiss the menu.
test.beforeAll(async () => {
  cacheDirectory = await mkdtemp(join(tmpdir(), 'zlayer-plate-menu-vite-'));
  server = await createServer({ cacheDir: cacheDirectory,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing development server address');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
  if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
});

test('the IAP menu stays open through StrictMode replay and restores focus on explicit dismissal', async ({ page }) => {
  await page.goto(`${origin}/test/browser/plate-menu.html`);
  await expect(page.locator('body')).toHaveAttribute('data-effect-setups', '2');
  const map = page.getByRole('region', { name: 'Test map' });
  const menu = page.getByRole('menu', { name: 'IAP actions' });
  const show = menu.getByRole('menuitem', { name: 'Show plate panel' });
  const hide = menu.getByRole('menuitem', { name: 'Hide IAP from map' });
  await map.click({ button: 'right', position: { x: 300, y: 300 } });
  await expect(menu).toBeVisible();
  await expect(show).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(hide).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(show).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(hide).toBeFocused();
  await page.keyboard.press('Home');
  await expect(show).toBeFocused();
  await page.keyboard.press('End');
  await expect(hide).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('Plate shown');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(map).toBeFocused();
  await map.click({ button: 'right', position: { x: 300, y: 300 } });
  await hide.click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Plate hidden');
  await expect(map).toBeFocused();
});
