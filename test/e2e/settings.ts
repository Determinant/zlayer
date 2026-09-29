import { expect, type Page } from '@playwright/test';

export async function selectCycle(page: Page, revision: string) {
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  const menu = page.getByRole('combobox', { name: 'FAA data cycle', exact: true });
  await menu.selectOption(revision);
  await expect(menu).toHaveValue(revision);
  await page.getByLabel('Close settings').click();
}

export async function expectCycle(page: Page, revision: string) {
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'FAA data cycle', exact: true })).toHaveValue(revision);
  await page.getByLabel('Close settings').click();
}
