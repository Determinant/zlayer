import { defineConfig } from '@playwright/test';
import base, { webServer } from './playwright.config';

export default defineConfig({
  ...base,
  grep: /@smoke/,
  // Smoke scenarios use static chart/PDF/graphics fixtures, not prepared forecasts.
  // A shared session keeps its existing weather setup for the other suites.
  ...(webServer ? { webServer: { ...webServer, env: { ZLAYER_TEST_SKIP_WEATHER: '1' } } } : {}),
});
