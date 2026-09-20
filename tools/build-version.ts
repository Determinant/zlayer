import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Use the package version and actual source commit, including in archive/CI builds. */
export function readBuildIdentity(): { version: string; commit: string } {
  const root = new URL('../', import.meta.url);
  const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version?: unknown };
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(version)) {
    throw new Error('The package version must be a semantic version without build metadata');
  }
  let commit = process.env.ZLAYER_GIT_COMMIT?.trim();
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      throw new Error('Cannot determine the source commit. Set ZLAYER_GIT_COMMIT to the full Git commit hash when building without Git metadata.');
    }
  }
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(commit)) throw new Error('ZLAYER_GIT_COMMIT must be a full Git commit hash');
  return { version, commit: commit.toLowerCase() };
}
