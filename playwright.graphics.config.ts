import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: ['graphics.spec.ts', 'map-resize.spec.ts', 'terrain.spec.ts', 'ownship.spec.ts', 'plate-fullscreen.spec.ts', 'plate-pinch.spec.ts'],
  outputDir: 'test-results/graphics',
  use: { ...base.use, launchOptions: {} },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: base.use?.launchOptions ?? {} } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'webkit-retina', use: { browserName: 'webkit', deviceScaleFactor: 2, hasTouch: true } },
  ],
});
