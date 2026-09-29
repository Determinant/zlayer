import { spawnSync } from 'node:child_process';
import { runBrowserSession } from './browser-session.mjs';

// Full local CI. Keep smoke selection confined to the GitHub workflow.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this command with npm run verify:full.');
const linux = process.platform === 'linux';
const suites = [
  { name: 'Complete Chromium browser suite', args: [
    '--output=test-results/local/browser'] },
  // Chromium graphics tests are already included in the complete browser suite.
  { name: 'WebKit graphics suites', args: ['--config=playwright.graphics.config.ts',
    '--project=webkit', '--project=webkit-retina',
    '--output=test-results/local/graphics'] },
  { name: 'Firefox graphics suite', args: ['--config=playwright.graphics.config.ts',
    '--project=firefox', ...(linux ? ['--headed'] : []),
    '--output=test-results/local/firefox'] },
];

const failed = [];
console.log('\nChecks, unit tests and production build');
const verified = spawnSync(process.execPath, [npm, 'run', 'verify'], { cwd: new URL('../', import.meta.url), stdio: 'inherit' });
if (verified.signal) process.exit(verified.signal === 'SIGINT' ? 130 : 1);
if (verified.error || verified.status !== 0) {
  failed.push('Checks, unit tests and production build');
  if (verified.error) console.error(verified.error.message);
}
try { failed.push(...await runBrowserSession(suites)); }
catch (error) { failed.push('Browser session'); console.error(error.message); }

if (failed.length) {
  console.error(`\nFull verification failed: ${failed.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('\nFull verification passed.');
}
