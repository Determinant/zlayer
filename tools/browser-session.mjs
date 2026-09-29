import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const grouped = process.platform !== 'win32';

function stop(child, signal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (grouped) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

/** Own one fresh production fixture server; suites remain sequential and isolated by reset. */
export async function runBrowserSession(suites) {
  if (!suites.length || suites.some(suite => !suite.args.length)) throw new Error('Provide at least one Playwright argument group.');
  const port = process.env.ZLAYER_TEST_PORT ?? '4197';
  const baseURL = `http://127.0.0.1:${port}`;
  const server = fork(resolve(root, 'test/e2e/server.mjs'), [], {
    cwd: root, detached: grouped, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const serverExit = once(server, 'exit');
  let active, interrupted;
  const interrupt = signal => { interrupted = signal; stop(active, signal); stop(server); };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const failed = [];
  try {
    let timer;
    try {
      await Promise.race([
        once(server, 'message').then(([message]) => {
          if (message !== 'ready') throw new Error('Unexpected fixture-server readiness message.');
        }),
        serverExit.then(() => { throw new Error('Fixture server exited before readiness.'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture preparation exceeded 240 seconds.')), 240_000); }),
      ]);
    } finally { clearTimeout(timer); }
    console.log(`\nFresh browser fixture ready at ${baseURL}; reusing this build for ${suites.length} suite(s).`);
    for (const suite of suites) {
      if (interrupted) break;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('Fixture server exited during the session.');
      const reset = await fetch(`${baseURL}/__test/reset`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
      if (!reset.ok) throw new Error(`Fixture reset failed: HTTP ${reset.status}`);
      console.log(`\n${suite.name}`);
      const useXvfb = process.platform === 'linux' && !process.env.DISPLAY && suite.args.includes('--headed');
      const args = [resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', ...suite.args];
      active = spawn(useXvfb ? 'xvfb-run' : process.execPath,
        useXvfb ? ['-a', process.execPath, ...args] : args, {
          cwd: root, detached: grouped, stdio: 'inherit',
          env: { ...process.env, ZLAYER_TEST_SESSION: '1' },
        });
      try {
        const [code, signal] = await once(active, 'exit');
        if (code !== 0 || signal) failed.push(suite.name);
      } catch (error) {
        failed.push(suite.name); console.error(error.message);
        if (useXvfb && error.code === 'ENOENT') console.error('Install Xvfb or provide DISPLAY for headed Linux browsers.');
      } finally { active = undefined; }
    }
    if (interrupted) throw new Error(`Browser session interrupted by ${interrupted}.`);
    return failed;
  } finally {
    stop(active); stop(server);
    const kill = setTimeout(() => stop(server, 'SIGKILL'), 5000);
    try { await serverExit; } finally {
      clearTimeout(kill);
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const groups = [[]];
  for (const argument of process.argv.slice(2)) {
    if (argument === '--next') groups.push([]);
    else groups.at(-1).push(argument);
  }
  try {
    const failed = await runBrowserSession(groups.map((args, i) => ({ name: `Browser suite ${i + 1}`, args })));
    if (failed.length) { console.error(`\nFailed: ${failed.join('; ')}`); process.exitCode = 1; }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
