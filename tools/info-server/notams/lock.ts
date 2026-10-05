import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { NotamError } from './error';

/** Kernel flock releases on crashes. The helper exits when the parent's pipe closes. */
export async function acquireNotamLock(path: string): Promise<{ assertHeld(): void; release(): Promise<void> }> {
  let child: ChildProcessWithoutNullStreams;
  try { child = spawn('flock', ['-n', '-x', path, process.execPath, '-e',
    'process.stdout.write("locked\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'], { stdio: 'pipe' }); }
  catch { throw new NotamError('writer-lock-unavailable'); }
  let held = true;
  const exited = new Promise<void>(resolve => child.once('close', () => { held = false; resolve(); }));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new NotamError('writer-lock-unavailable')); }, 5000);
      child.once('error', () => { clearTimeout(timer); reject(new NotamError('writer-lock-unavailable')); });
      child.once('exit', () => { clearTimeout(timer); reject(new NotamError('writer-already-active')); });
      child.stdout.once('data', chunk => {
        clearTimeout(timer);
        if (chunk.toString() === 'locked\n') resolve(); else reject(new NotamError('writer-lock-unavailable'));
      });
    });
  } catch (error) { child.kill(); await exited; throw error; }
  return {
    assertHeld() { if (!held || child.exitCode !== null || child.signalCode !== null) throw new NotamError('writer-lock-lost'); },
    async release() { child.stdin.end(); await exited; },
  };
}
