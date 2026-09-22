import { expect, test, type Page } from '@playwright/test';

async function back(page: Page) {
  const url = page.url();
  // Wait for both the Back traversal and the guard's forward traversal.
  await page.evaluate(() => new Promise<void>(resolve => {
    const returned = () => {
      if (history.state?.__zlayerPwaBack !== 'guard-v1') return;
      window.removeEventListener('popstate', returned);
      resolve();
    };
    window.addEventListener('popstate', returned);
    history.back();
  }));
  await expect(page).toHaveURL(url);
}

for (const standalone of ['display-mode', 'ios'] as const) {
  test.describe(`installed Back via ${standalone}`, () => {
    test.use({ hasTouch: true });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(mode => {
        if (mode === 'ios') Object.defineProperty(navigator, 'standalone', { value: true });
        else {
          const original = window.matchMedia.bind(window);
          window.matchMedia = query => {
            const result = original(query);
            if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true });
            return result;
          };
        }
      }, standalone);
    });

    test('stows the last used edge, keeps drafts, and ignores Back on an empty workspace', async ({ page }) => {
      await page.goto('/test/browser/edge-panels.html?layout=compact');
      const initialLength = await page.evaluate(() => history.length);
      await page.getByRole('button', { name: 'Open left-a', exact: true }).click();
      await page.getByRole('button', { name: 'Open right-a', exact: true }).click();
      await expect(page.locator('.edge-panel.is-open')).toHaveCount(2);
      await page.getByLabel('left-a value').fill('Retain this draft');
      await back(page);
      await expect(page.locator('.edge-panels.is-left')).not.toHaveAttribute('data-active');
      await expect(page.locator('.edge-panels.is-right')).toHaveAttribute('data-active', 'right-a');
      await expect(page.getByRole('button', { name: 'Show left-a', exact: true })).toBeFocused();
      await back(page);
      await expect(page.locator('.edge-panel.is-open')).toHaveCount(0);
      for (let i = 0; i < 3; i++) await back(page);
      expect(await page.evaluate(() => history.length)).toBe(initialLength + 1);
      await page.getByRole('button', { name: 'Show left-a', exact: true }).click();
      await expect(page.getByLabel('left-a value')).toHaveValue('Retain this draft');
      await page.getByRole('button', { name: 'Open left-b', exact: true }).click();
      await expect(page.locator('.edge-panels.is-left')).toHaveAttribute('data-active', 'left-b');
      await back(page);
      await expect(page.locator('.edge-panel.is-open')).toHaveCount(0);
      expect(await page.evaluate(() => history.length)).toBe(initialLength + 1);
    });

    test('Back requests guarded stow, then cancels the confirmation before touching a panel', async ({ page }) => {
      await page.goto('/test/browser/edge-panels.html?guard');
      // Exercise the cancel-event fallback used by older iOS versions too.
      if (standalone === 'ios') await page.evaluate(() =>
        Object.defineProperty(HTMLDialogElement.prototype, 'requestClose', { value: undefined }));
      await page.getByRole('button', { name: 'Open right-b', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Stow right-b?', exact: true });
      await back(page);
      await expect(dialog).toBeVisible();
      await back(page);
      await expect(dialog).toBeHidden();
      await expect(page.locator('.edge-panels.is-right')).toHaveAttribute('data-active', 'right-b');
      await back(page);
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.locator('.edge-panel.is-open')).toHaveCount(0);
      await back(page);
      await expect(dialog).toBeHidden();
    });

    test('a tap on the bare map protects idle Back without changing the URL or other history state', async ({ page }) => {
      await page.goto('/test/browser/edge-panels.html?layout=compact#map');
      await page.evaluate(() => history.replaceState({ retained: 'workspace' }, ''));
      const length = await page.evaluate(() => history.length);
      await page.locator('#panels').tap({ position: { x: 500, y: 100 } });
      for (let i = 0; i < 3; i++) await back(page);
      expect(await page.evaluate(() => history.state.retained)).toBe('workspace');
      expect(await page.evaluate(() => history.length)).toBe(length + 1);
      await expect(page).toHaveURL(/\?layout=compact#map$/);
    });

    test('reloads reuse history and removed contributions leave no stale Back target', async ({ page }) => {
      await page.goto('/test/browser/edge-panels.html?restore');
      await page.getByRole('button', { name: 'Toggle right-c', exact: true }).click();
      await expect(page.getByLabel('right-c value')).toBeVisible();
      const length = await page.evaluate(() => history.length);
      await page.reload();
      await page.getByRole('button', { name: 'Toggle right-c', exact: true }).click();
      await expect(page.getByLabel('right-c value')).toBeVisible();
      await back(page);
      await expect(page.locator('.edge-panels.is-right')).not.toHaveAttribute('data-active');
      await page.getByRole('button', { name: 'Open left-a', exact: true }).click();
      await page.getByRole('button', { name: 'Open right-c', exact: true }).click();
      await page.getByRole('button', { name: 'Toggle right-c', exact: true }).click();
      await expect(page.getByLabel('right-c value')).toHaveCount(0);
      await back(page);
      await expect(page.locator('.edge-panels.is-left')).not.toHaveAttribute('data-active');
      expect(await page.evaluate(() => history.length)).toBe(length);
    });

    test.describe('mobile workspace', () => {
      test.use({ viewport: { width: 393, height: 852 }, isMobile: true });
      test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('zlayers-map-preferences-v1',
          JSON.stringify({ chartBase: '', ownshipEnabled: false })));
      });

      test('nested Settings/About, layers, and terrain help dismiss one at a time', async ({ page }) => {
        await page.goto('/');
        await page.getByRole('button', { name: 'Settings and offline downloads', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await settings.getByRole('button', { name: 'About ZLayer', exact: true }).click();
        await back(page);
        await expect(page.getByRole('dialog', { name: 'About ZLayer', exact: true })).toBeHidden();
        await expect(settings).toBeVisible();
        await back(page);
        await expect(settings).toBeHidden();
        await page.getByRole('button', { name: 'Open map layers', exact: true }).click();
        const help = page.getByRole('button', { name: 'About route terrain', exact: true });
        await help.click();
        await expect(page.getByRole('tooltip')).toBeVisible();
        await back(page);
        await expect(page.getByRole('tooltip')).toBeHidden();
        await expect(page.getByRole('button', { name: 'Close map layers', exact: true })).toBeVisible();
        await back(page);
        await expect(page.getByRole('button', { name: 'Open map layers', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Hide terrain toolbox', exact: true })).toBeVisible();
      });

      test('AHRS exits fullscreen, closes its recorder, and preserves the stow confirmation', async ({ page }) => {
        await page.goto('/');
        await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
        const tool = page.getByRole('region', { name: 'AHRS toolbox', exact: true });
        await tool.getByRole('button', { name: 'Enter full screen', exact: true }).click();
        const fullScreen = page.getByRole('dialog', { name: 'AHRS full screen', exact: true });
        await fullScreen.getByRole('button', { name: 'AHRS recorder', exact: true }).click();
        await expect(page.getByRole('region', { name: 'AHRS recordings', exact: true })).toBeVisible();
        await back(page);
        await expect(page.getByRole('region', { name: 'AHRS recordings', exact: true })).toBeHidden();
        await expect(fullScreen).toBeVisible();
        await fullScreen.getByRole('button', { name: 'AHRS recorder', exact: true }).click();
        // Android can send a native dialog close request instead of popstate.
        await fullScreen.evaluate(dialog => (dialog as HTMLDialogElement).requestClose());
        await expect(page.getByRole('region', { name: 'AHRS recordings', exact: true })).toBeHidden();
        await expect(fullScreen).toBeVisible();
        await back(page);
        await expect(fullScreen).toHaveCount(0);
        await back(page);
        const confirmation = page.getByRole('alertdialog', { name: 'Stow AHRS?', exact: true });
        await expect(confirmation).toBeVisible();
        await back(page);
        await expect(confirmation).toBeHidden();
        await expect(tool).toBeVisible();
        await back(page);
        await confirmation.getByRole('button', { name: 'Background', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Show AHRS toolbox', exact: true })).toBeVisible();
      });

      test('Back clears search, stows a plate after leaving fullscreen, and preserves its selection', async ({ page }) => {
        await page.goto('/');
        const search = page.getByLabel('Search FAA navigation data');
        await search.tap();
        await search.fill('KSBA');
        await back(page);
        await expect(search).toHaveValue('');
        await search.fill('KSBA');
        await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
        await page.getByRole('tab', { name: 'Plates', exact: true }).click();
        await page.getByRole('button', { name: /TEST APPROACH/ }).click();
        await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
        const viewer = page.locator('.procedure-viewer');
        await viewer.getByRole('button', { name: 'Enter full screen', exact: true }).click();
        await back(page);
        await expect(viewer).not.toHaveClass(/is-fullscreen/);
        await back(page);
        await expect(page.locator('.side-panels .edge-panel.is-open')).toHaveCount(0);
        await page.getByRole('button', { name: 'Show KSBA plate', exact: true }).click();
        await expect(viewer).toBeVisible();
        await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
      });

      test('the route export submenu closes before the route menu', async ({ page }) => {
        await page.goto('/');
        const input = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
        await input.fill('KSBA KSMO');
        await input.press('Enter');
        const trigger = page.getByRole('button', { name: 'Route actions', exact: true });
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Copy Route', exact: true }).click();
        await expect(page.getByRole('menu', { name: 'Copy route format', exact: true })).toBeVisible();
        await back(page);
        await expect(page.getByRole('menu', { name: 'Copy route format', exact: true })).toBeHidden();
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        await back(page);
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      });

      test('Back cannot acknowledge the welcome notice', async ({ page }) => {
        await page.addInitScript(() => localStorage.removeItem('zlayer-ui:welcome-acknowledged'));
        await page.goto('/');
        const welcome = page.getByRole('dialog', { name: 'Welcome to ZLayer', exact: true });
        await welcome.getByRole('heading', { name: 'Welcome to ZLayer', exact: true }).click();
        await back(page);
        await expect(welcome).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem('zlayer-ui:welcome-acknowledged'))).toBeNull();
      });
    });
  });
}

test('ordinary browser tabs keep their navigation history', async ({ page }) => {
  await page.goto('/test/browser/edge-panels.html?previous');
  await page.goto('/test/browser/edge-panels.html');
  const length = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Open right-a', exact: true }).click();
  await expect(page.locator('.edge-panels.is-right')).toHaveAttribute('data-active', 'right-a');
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect(page).toHaveURL(/\?previous$/);
});
