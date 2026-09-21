import { expect, type Page } from '@playwright/test';

/** Stow the current panel to expose the tabs behind it, then pull out another. */
export async function openSidePanel(page: Page, name: 'details' | 'plate') {
  const group = page.locator('.side-panels');
  const handle = group.locator(`[data-edge-tab="${name}"] button`);
  if (await handle.getAttribute('aria-expanded') !== 'true') {
    const current = group.locator('.edge-panel-tabs [aria-expanded="true"]');
    if (await current.count()) await current.click();
    await expect(group.locator('.edge-panel.is-presented')).toHaveCount(0);
    await handle.click();
  }
  await expect(group.locator('.edge-panel.is-open')).toHaveCount(1);
  await group.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
}
