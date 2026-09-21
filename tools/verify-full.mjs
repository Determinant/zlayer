import { spawnSync } from 'node:child_process';

// Full local CI. Keep smoke selection confined to the GitHub workflow.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this command with npm run verify:full.');
const linux = process.platform === 'linux';
const stages = [
  { name: 'Checks, unit tests and production build', args: ['run', 'verify'] },
  { name: 'Complete Chromium browser suite', args: ['run', 'test:browser', '--',
    '--output=test-results/local/browser'] },
  { name: 'Chromium and WebKit graphics suites', args: ['run', 'test:graphics', '--',
    '--project=chromium', '--project=webkit', '--project=webkit-retina',
    '--output=test-results/local/graphics'] },
  { name: 'Firefox graphics suite', display: linux, args: ['run', 'test:graphics', '--',
    '--project=firefox', ...(linux ? ['--headed'] : []),
    '--output=test-results/local/firefox'] },
];

const failed = [];
for (const stage of stages) {
  console.log(`\n${stage.name}`);
  const useXvfb = stage.display && !process.env.DISPLAY;
  const command = useXvfb ? 'xvfb-run' : process.execPath;
  const args = useXvfb ? ['-a', process.execPath, npm, ...stage.args] : [npm, ...stage.args];
  // One server at a time: browser tests mutate shared synthetic origin state.
  const result = spawnSync(command, args, { cwd: new URL('../', import.meta.url), stdio: 'inherit' });
  if (result.signal) {
    console.error(`Interrupted ${stage.name}: ${result.signal}`);
    process.exit(result.signal === 'SIGINT' ? 130 : 1);
  }
  if (result.error || result.status !== 0) {
    failed.push(stage.name);
    if (result.error) console.error(result.error.message);
    if (useXvfb && result.error?.code === 'ENOENT') {
      console.error('Install Xvfb (xvfb-run) or run with a desktop DISPLAY for Linux Firefox WebGL tests.');
    }
  }
}

if (failed.length) {
  console.error(`\nFull verification failed: ${failed.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('\nFull verification passed.');
}
