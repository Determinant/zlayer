import { parentPort } from 'node:worker_threads';
import { decodeWeatherPng } from './png';
import { progsCoverageImageSize } from '@zlayer/contracts';
import { workerFailure, type WorkerResult } from './worker-protocol';

parentPort!.once('message', (images: Uint8Array[]) => {
  try {
    for (const bytes of images) {
      const { width, height } = progsCoverageImageSize(bytes);
      decodeWeatherPng(bytes, { width, height, depth: 8, channels: 4 });
    }
    parentPort!.postMessage({ type: 'done', value: true } satisfies WorkerResult<boolean>);
  } catch (error) { parentPort!.postMessage(workerFailure(error)); }
});
