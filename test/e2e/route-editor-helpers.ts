import { expect, type Locator, type Page } from '@playwright/test';

export async function longRoute(page: Page, withApproach = false) {
  await page.addInitScript(withApproach => {
    if (localStorage.getItem('zlayer-route-draft-v1')) return;
    localStorage.setItem('zlayer-route-draft-v1', JSON.stringify({ version: 2,
      entries: Array.from({ length: 24 }, (_, i) => ({ id: `entry-${i}`, text: i % 2 ? 'KSJC' : 'KSFO',
        ...(withApproach && i === 0 ? { approach: { airportId: 'KSFO', procedureId: 'ils', name: 'ILS OR LOC RWY 28R', cycle: '2609',
          entry: { routeId: 'KSFO:I28R', transitionId: 'transition:ARCHI', name: 'ARCHI', effectiveDate: '2026-09-03' } } } : {}),
      })),
    }));
  }, withApproach);
  await page.goto('/test/browser/routes.html');
  const editor = page.locator('.route-editor');
  await expect(page.locator('.route-token')).toHaveCount(24);
  await editor.evaluate(element => { element.scrollLeft = 0; });
  return editor;
}

export const entryIds = (page: Page) => page.locator('[data-route-entry]').evaluateAll(elements =>
  elements.map(element => (element as HTMLElement).dataset.routeEntry));
export const scrollLeft = (editor: Locator) => editor.evaluate(element => element.scrollLeft);
export async function center(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
