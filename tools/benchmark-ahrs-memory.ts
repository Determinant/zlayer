/** Node retention probe, not a Safari/GPU or real-time performance measurement.
 * Run: node --expose-gc --import=tsx tools/benchmark-ahrs-memory.ts
 */
import { createAhrsLayer } from '../src/layers/ahrs/layer';
import { G } from '../src/layers/ahrs/estimator/math';
import type { ImuSample } from '../src/layers/ahrs/estimator/types';

if (!global.gc) throw new Error('Run with node --expose-gc --import=tsx');
const collect = global.gc;
let now = 0, onSample: ((sample: ImuSample) => void) | undefined;
const layer = createAhrsLayer({
  getSnapshot: () => ({ state: 'off', fix: null }),
  subscribe: () => () => {}, acquire: () => () => {}, retry() {},
}, {
  now: () => now, timeOrigin: 0,
  motion: (_mount, sample) => {
    onSample = sample;
    return { start: async () => {}, stop: () => { onSample = undefined; } };
  },
});

async function measure(phase: string) {
  // Give dead callback temporaries an event-loop turn before each collection.
  await new Promise<void>(resolve => setImmediate(resolve));
  collect();
  await new Promise<void>(resolve => setImmediate(resolve));
  collect();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  console.log(JSON.stringify({ phase, simulatedSeconds: now, heapUsed, arrayBuffers }));
}

await measure('idle');
try {
  await layer.calibrate();
  for (let i = 1; i <= 120 * 60; i++) {
    now = i / 60;
    onSample!({ time: now, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
    if (i % (30 * 60) === 0) await measure('active');
  }
} finally { layer.stop(); }
await measure('stopped');
