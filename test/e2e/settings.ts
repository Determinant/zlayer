import { expect, type Page } from '@playwright/test';

export async function selectCycle(page: Page, revision: string) {
  await page.getByLabel('Settings and offline downloads').click();
  const menu = page.getByLabel('FAA data cycle');
  await menu.selectOption(revision);
  await expect(menu).toHaveValue(revision);
  await page.getByLabel('Close settings').click();
}

export async function expectCycle(page: Page, revision: string) {
  await page.getByLabel('Settings and offline downloads').click();
  await expect(page.getByLabel('FAA data cycle')).toHaveValue(revision);
  await page.getByLabel('Close settings').click();
}
