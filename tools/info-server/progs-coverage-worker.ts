import { parentPort } from 'node:worker_threads';
import { decodeWeatherPng } from './png';
import { progsCoverageImageSize } from '@zlayer/contracts';
import { workerFailure, type WorkerResult } from './worker-protocol';

parentPort!.once('message', (images: Uint8Array[]) => {
  try {
    const invalid: number[] = [];
    let failure: unknown;
    for (const [index, bytes] of images.entries()) {
      try {
        const { width, height } = progsCoverageImageSize(bytes);
        decodeWeatherPng(bytes, { width, height, depth: 8, channels: 4 });
      } catch (cause) { invalid.push(index); failure ??= cause; }
    }
    if (invalid.length) { parentPort!.postMessage(workerFailure(failure, invalid)); return; }
    parentPort!.postMessage({ type: 'done', value: true } satisfies WorkerResult<boolean>);
  } catch (error) { parentPort!.postMessage(workerFailure(error)); }
});
