import { test, expect } from '@playwright/test';

type StreamingWindow = Window & typeof globalThis & {
  plateDownloadFixture: { requests: number; advance: () => void; finish: () => void };
};

for (const supplement of [false, true]) {
  test(`${supplement ? 'CS' : 'TPP'} shows live download progress, resumes it on reopen, and reuses the saved region`, async ({ page }, testInfo) => {
    await page.setViewportSize(supplement ? { width: 1280, height: 900 } : { width: 393, height: 852 });
    // Hold a real PDF response at known byte boundaries, without timing-dependent sleeps.
    await page.addInitScript(() => {
      const fixture = (window as StreamingWindow).plateDownloadFixture = {
        requests: 0, advance: () => {}, finish: () => {},
      };
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (!new URL(response.url).pathname.endsWith('/book.pdf')) return response;
        fixture.requests++;
        const bytes = new Uint8Array(await response.arrayBuffer());
        let offset = Math.ceil(bytes.length / 2);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, offset));
            fixture.advance = () => {
              const next = Math.ceil(bytes.length * 0.75);
              controller.enqueue(bytes.slice(offset, next));
              offset = next;
            };
            fixture.finish = () => {
              controller.enqueue(bytes.slice(offset));
              controller.close();
            };
          },
        }), { status: response.status, headers: response.headers });
      };
    });
    await page.goto('/');
    await page.getByLabel('Search FAA navigation data').fill('KSBA');
    await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
    await page.getByRole('button', { name: 'Plates', exact: true }).click();
    const opener = page.getByRole('button', { name: supplement ? /Chart Supplement/ : /TEST APPROACH/ });
    await opener.click();
    const meter = page.getByRole('progressbar', {
      name: supplement ? 'Downloading Chart Supplement…' : 'Downloading regional plates…',
    });
    await expect(meter).toHaveAttribute('aria-valuenow', '50');
    await expect(page.getByRole('status').filter({ hasText: 'The first download may take a moment.' })).toContainText(
      `Once saved, other ${supplement ? 'airport entries' : 'plates'} in this regional book open much faster.`);
    await expect(page.locator('.procedure-download-amount')).toContainText('0.1 MB of 0.3 MB');
    await expect(page.locator('.procedure-page-stage canvas')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('download-halfway.png') });
    if (!supplement) {
      await page.setViewportSize({ width: 852, height: 393 });
      await expect(meter).toBeInViewport();
      await expect(page.locator('.procedure-download-amount')).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('download-landscape.png') });
      await page.setViewportSize({ width: 393, height: 852 });
    }
    await page.getByRole('button', { name: 'Close plate', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await opener.click();
    await expect(meter).toHaveAttribute('aria-valuenow', '50');
    await page.evaluate(() => (window as StreamingWindow).plateDownloadFixture.advance());
    await expect(meter).toHaveAttribute('aria-valuenow', '75');
    await page.evaluate(() => (window as StreamingWindow).plateDownloadFixture.finish());
    await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.procedure-page-stage canvas')).toBeVisible();
    await expect(page.locator('.procedure-cache-state')).toHaveText('Available offline');
    await expect(meter).toHaveCount(0);
    await page.getByRole('button', { name: 'Close plate', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The fixture shares a physical book across these two regional references.
    await page.getByRole('button', { name: supplement ? /TEST APPROACH/ : /Chart Supplement/ }).click();
    await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.procedure-page-stage canvas')).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    expect(await page.evaluate(() => (window as StreamingWindow).plateDownloadFixture.requests)).toBe(1);
  });
}
