import { defineConfig } from '@playwright/test';

const baseURL = `http://127.0.0.1:${process.env.ZLAYER_TEST_PORT ?? 4197}`;

// The real weather processor prepares the native fixture cache once at startup.
// Only the session runner sets this flag, after its own fresh server reports ready.
export const webServer = process.env.ZLAYER_TEST_SESSION === '1' ? undefined
  : { command: 'node test/e2e/server.mjs', url: baseURL, timeout: 240_000 };

export default defineConfig({
  testDir: './test/e2e', testMatch: '**/*.spec.ts', timeout: 60_000, workers: 1,
  forbidOnly: !!process.env.CI,
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
  ...(webServer ? { webServer } : {}),
});
