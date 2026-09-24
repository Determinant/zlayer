import { defineConfig } from '@playwright/test';

const baseURL = `http://127.0.0.1:${process.env.ZLAYER_TEST_PORT ?? 4197}`;

export default defineConfig({
  testDir: './test/e2e', testMatch: '**/*.spec.ts', timeout: 60_000, workers: 1,
  use: {
    baseURL, browserName: 'chromium', viewport: { width: 1280, height: 900 },
    // Workspace regressions start as returning users; welcome.spec.ts covers first visits.
    storageState: { cookies: [], origins: [{ origin: baseURL, localStorage: [
      { name: 'zlayer-ui:welcome-acknowledged', value: JSON.stringify({ version: 1, value: true }) },
    ] }] },
    trace: 'retain-on-failure', actionTimeout: 10_000,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  // The real weather processor prepares the native fixture cache once at startup.
  webServer: { command: 'node test/e2e/server.mjs', url: baseURL, timeout: 240_000 },
});
