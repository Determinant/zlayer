import { test, expect } from '@playwright/test';

test('GS and ALT digits fit their windows from one digit through six digits and during carries', async ({ page }, testInfo) => {
  await page.goto('/test/browser/ahrs-drums.html');
  await expect(page.getByRole('img', { name: /^Ground speed:/ })).toHaveCount(24);
  await expect(page.getByRole('img', { name: /^GPS altitude:/ })).toHaveCount(24);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('16px B612'))).toBe(true);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    // Check actual B612 glyph bounds against each column's clipping rectangle.
    // Rolling intentionally clips vertically; no glyph may be cut horizontally.
    const clipped = await page.locator('.ahrs-drum g[transform]').evaluateAll(groups => groups.flatMap(group => {
      const columnWindow = group.parentElement!;
      const clipId = columnWindow.getAttribute('clip-path')!.slice(5, -1);
      const rect = document.getElementById(clipId)!.querySelector('rect')!;
      const left = rect.x.baseVal.value, right = left + rect.width.baseVal.value;
      return [...group.querySelectorAll('text')].filter(text => {
        if (!text.textContent) return false;
        const bounds = text.getBBox();
        return bounds.x < left - .05 || bounds.x + bounds.width > right + .05;
      }).map(text => `${text.closest('svg')!.getAttribute('aria-label')}: ${text.textContent}, glyph ${text.getBBox().x}/${text.getBBox().width}, window ${left}/${right}`);
    }));
    expect(clipped).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`digit-boundaries-${width}.png`), fullPage: true });
  }
});
