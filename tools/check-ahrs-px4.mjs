import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = resolve(root, 'src/layers/ahrs/estimator/px4');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const upstream = JSON.parse(readFileSync(resolve(port, 'upstream.json'), 'utf8'));
const build = JSON.parse(readFileSync(resolve(port, 'generated/build.json'), 'utf8'));
const expectedInputs = [
  'tools/build-ahrs-px4.py',
  ...['upstream.json', 'browser.patch', 'bridge.cpp', 'snapshot.json',
    ...Object.keys(upstream.sha256).map(path => `vendor/${path}`)]
    .map(path => `src/layers/ahrs/estimator/px4/${path}`),
].sort();
if (JSON.stringify(Object.keys(build.inputs).sort()) !== JSON.stringify(expectedInputs))
  throw new Error('PX4 build input inventory changed; run npm run ahrs:build');
for (const [path, expected] of Object.entries(upstream.sha256)) {
  if (digest(resolve(port, 'vendor', path)) !== expected) throw new Error(`PX4 upstream source changed: ${path}; use browser.patch`);
}
for (const [path, expected] of Object.entries(build.inputs)) {
  if (digest(resolve(root, path)) !== expected) throw new Error(`PX4 build is stale after ${path}; run npm run ahrs:build`);
}
if (digest(resolve(port, 'generated/ekf.js')) !== build.output) throw new Error('PX4 generated module changed; rebuild from pinned sources');
console.log(`PX4 ${upstream.tag}: vendored sources and generated module match their hashes`);
