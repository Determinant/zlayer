import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: ['graphics.spec.ts', 'map-resize.spec.ts', 'terrain.spec.ts', 'glide.spec.ts', 'glide-landings.spec.ts',
    'glide-packages.spec.ts', 'ownship.spec.ts', 'plate-fullscreen.spec.ts', 'plate-pinch.spec.ts'],
  outputDir: 'test-results/graphics',
  use: { ...base.use, launchOptions: {} },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: base.use?.launchOptions ?? {} } },
    { name: 'firefox', use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: {
      // Exercise real persistent storage without an unattended native prompt.
      // Playwright's permission grant does not settle StorageManager.persist().
      'dom.storageManager.prompt.testing': true,
      'dom.storageManager.prompt.testing.allow': true,
    } } } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    // Tagged cases supply their own full density/input matrix and already run in webkit.
    { name: 'webkit-retina', grepInvert: /@explicit-density/,
      use: { browserName: 'webkit', deviceScaleFactor: 2, hasTouch: true } },
  ],
});
