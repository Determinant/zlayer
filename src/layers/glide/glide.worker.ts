import { expose } from 'comlink';
import { createTerrainElevationReader } from '../terrain/data';
import { GlidePlanner } from './planner';
import type { GlideRequest, GlideResult, GlideWorker } from './types';
let calculator: GlidePlanner | undefined, key = '';
const jobs = new Map<number, AbortController>();
async function calculate(request: GlideRequest): Promise<GlideResult> {
  const controller = new AbortController(); jobs.set(request.id, controller);
  try {
    const nextKey = JSON.stringify([request.sourceKey, request.base, request.tileUrl]);
    if (!calculator || key !== nextKey) {
      calculator = new GlidePlanner(createTerrainElevationReader(request.sources, request.base, request.tileUrl)); key = nextKey;
    }
    return await calculator.calculate(request, controller.signal);
  } finally { jobs.delete(request.id); }
}
expose({ calculate, cancel(id) { jobs.get(id)?.abort(); } } satisfies GlideWorker);
