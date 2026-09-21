import { expect, test, type Locator } from '@playwright/test';

async function settled(group: Locator, name: string | null) {
  await expect(group.locator('.edge-panel.is-presented')).toHaveCount(name ? 1 : 0);
  await expect.poll(() => group.evaluate(group => group.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
  if (name) await expect(group.locator(`[data-edge-tab="${name}"] button`)).toHaveAttribute('aria-expanded', 'true');
}

for (const layout of ['rail', 'compact']) {
  test(`registered layers share lifecycle on either edge with ${layout} tabs`, async ({ page }) => {
    await page.goto(`/test/browser/edge-panels.html?layout=${layout}`);
    const allInputs = page.locator('input');
    // Rendering the same registry under both groups mounts each contribution once.
    await expect(allInputs).toHaveCount(4);
    for (const side of ['left', 'right']) {
      const group = page.locator(`.edge-panels.is-${side}`);
      const a = group.locator(`[data-edge-tab="${side}-a"] button`);
      const b = group.locator(`[data-edge-tab="${side}-b"] button`);
      const positions = [await a.boundingBox(), await b.boundingBox()];
      await a.click();
      await settled(group, `${side}-a`);
      const input = page.getByLabel(`${side}-a value`);
      await input.fill('Keep this draft');
      await input.press('Escape');
      await settled(group, null);
      await expect(a).toBeFocused();
      await a.press('Enter');
      await a.press('Tab');
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('Keep this draft');
      await a.click();
      await settled(group, null);
      await b.click();
      await settled(group, `${side}-b`);
      await page.getByRole('button', { name: `Close ${side}-b`, exact: true }).click();
      await expect(b).toHaveCount(0);
      expect((await a.boundingBox())!.y).toBe(positions[0]!.y);
      // A new third slot does not move the first, including while selected.
      await page.getByRole('button', { name: `Toggle ${side}-c`, exact: true }).click();
      await page.getByRole('button', { name: `Open ${side}-c`, exact: true }).click();
      await settled(group, `${side}-c`);
      expect((await a.boundingBox())!.y).toBe(positions[0]!.y);
      await page.getByRole('button', { name: `Toggle ${side}-b`, exact: true }).click();
      expect((await b.boundingBox())!.y).toBe(positions[1]!.y);
    }
    await expect(page.locator('.edge-panel.is-open')).toHaveCount(2);
    await expect(page.locator('[data-edge-tab]')).toHaveCount(6);
  });

  test(`delayed contributions slide in under an already selected id with ${layout} tabs`, async ({ page }) => {
    await page.goto(`/test/browser/edge-panels.html?layout=${layout}&restore`);
    for (const side of ['left', 'right']) {
      const positions = await page.evaluate(async side => {
        const positions: number[] = [];
        window.dispatchEvent(new Event(`toggle:${side}-c`));
        const start = performance.now();
        do {
          await new Promise(requestAnimationFrame);
          const group = document.querySelector(`.edge-panels.is-${side}`)!;
          const body = group.querySelector('.is-presented .edge-panel-body');
          if (body) positions.push(Math.round(body.getBoundingClientRect().x));
        } while (performance.now() - start < 400);
        return positions;
      }, side);
      expect(new Set(positions).size, 'a late panel still gets an entrance slide').toBeGreaterThan(2);
      await settled(page.locator(`.edge-panels.is-${side}`), `${side}-c`);
    }
  });

  test(`guards defer switches and closes on either edge with ${layout} tabs`, async ({ page }) => {
    await page.goto(`/test/browser/edge-panels.html?layout=${layout}&guard`);
    for (const side of ['left', 'right']) {
      const group = page.locator(`.edge-panels.is-${side}`);
      const a = group.locator(`[data-edge-tab="${side}-a"] button`);
      const b = group.locator(`[data-edge-tab="${side}-b"] button`);
      const confirmation = page.getByRole('dialog', { name: `Stow ${side}-b?`, exact: true });
      await b.click();
      await settled(group, `${side}-b`);
      await page.getByLabel(`${side}-b value`).press('Escape');
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
      await settled(group, `${side}-b`);
      // A stale confirmation cannot override newer controlled selections,
      // including leaving and returning to the original panel.
      await a.evaluate(button => (button as HTMLButtonElement).click());
      await expect(confirmation).toBeVisible();
      await page.getByRole('button', { name: `Open ${side}-a`, exact: true }).evaluate(button => (button as HTMLButtonElement).click());
      await settled(group, `${side}-a`);
      await page.getByRole('button', { name: `Open ${side}-b`, exact: true }).evaluate(button => (button as HTMLButtonElement).click());
      await settled(group, `${side}-b`);
      await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
      await settled(group, `${side}-b`);
      await a.evaluate(button => (button as HTMLButtonElement).click());
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
      await settled(group, `${side}-a`);
      await a.click();
      await settled(group, null);
      await b.click();
      await settled(group, `${side}-b`);
      await page.getByRole('button', { name: `Close ${side}-b`, exact: true }).click();
      await expect(confirmation).toBeVisible();
      await expect(b).toHaveCount(1);
      await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(b).toHaveCount(0);
      await settled(group, null);
    }
  });
}
