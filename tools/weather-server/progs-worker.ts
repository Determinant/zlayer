import { parentPort } from 'node:worker_threads';
import { isSurfaceArtifact, surfacePositions, SURFACE_MAX_BYTES, SURFACE_PROCESSING, type SurfaceProduct } from '@zlayer/contracts';
import { parseSurfaceChart, type SurfaceChart } from '../../src/layers/weather-awc/progs/source';
import { workerFailure, type WorkerResult } from './worker-protocol';

export type SurfaceJob = { text: string; chart: SurfaceChart; checkedAt: number; sourceHash: string };
export type SurfaceResult = { body: ArrayBuffer; positions: number; documentLength: number };
parentPort!.on('message', ({ product, jobs }: { product: SurfaceProduct; jobs: SurfaceJob[] }) => {
  try {
    let size = 0;
    const bodies = jobs.map(job => {
      const artifact = { schemaVersion: 1, processing: SURFACE_PROCESSING, product,
        frame: parseSurfaceChart(job.text, job.chart, job.checkedAt, job.sourceHash) };
      if (!isSurfaceArtifact(artifact)) throw new Error('Invalid prepared surface chart');
      const body = new TextEncoder().encode(JSON.stringify(artifact)).buffer;
      size += body.byteLength;
      if (size > SURFACE_MAX_BYTES) throw new Error('Prepared surface charts exceed their size limit');
      return { body, positions: surfacePositions(artifact.frame), documentLength: artifact.frame.sourceDocument.length };
    });
    parentPort!.postMessage({ type: 'done', value: bodies } satisfies WorkerResult<SurfaceResult[]>, bodies.map(result => result.body));
  } catch (error) { parentPort!.postMessage(workerFailure(error)); }
});
