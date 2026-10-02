import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: ['graphics.spec.ts', 'map-resize.spec.ts', 'terrain.spec.ts', 'glide.spec.ts', 'ownship.spec.ts', 'plate-fullscreen.spec.ts', 'plate-pinch.spec.ts'],
  outputDir: 'test-results/graphics',
  use: { ...base.use, launchOptions: {} },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: base.use?.launchOptions ?? {} } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    // Tagged cases supply their own full density/input matrix and already run in webkit.
    { name: 'webkit-retina', grepInvert: /@explicit-density/,
      use: { browserName: 'webkit', deviceScaleFactor: 2, hasTouch: true } },
  ],
});
