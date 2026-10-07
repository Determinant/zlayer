import { test as base } from '@playwright/test';

/** WebKit's ephemeral profile loses worker-owned Cache Storage when that worker
 * exits. Persistence regressions need a fresh disk-backed profile, as the PWA uses. */
export const test = base.extend({
  context: async ({ context, browserName, playwright, baseURL, headless, launchOptions,
    contextOptions, viewport, deviceScaleFactor, hasTouch, storageState }, use, testInfo) => {
    if (browserName !== 'webkit') { await use(context); return; }
    const persistent = await playwright.webkit.launchPersistentContext(testInfo.outputPath('profile'), {
      ...launchOptions, ...contextOptions, baseURL: baseURL!, headless, viewport,
      ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }), hasTouch,
    });
    try {
      if (storageState) await persistent.setStorageState(storageState);
      await use(persistent);
    } finally { await persistent.close(); }
  },
});
