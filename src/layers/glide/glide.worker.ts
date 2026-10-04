import { expose } from 'comlink';
import { createTerrainElevationReader } from '../terrain/data';
import { GlidePlanner } from './planner';
import type { GlideRequest, GlideResponse, GlideWorker } from './types';
let calculator: GlidePlanner | undefined, key = '', plannerGeneration = 0;
const jobs = new Map<number, AbortController>();
async function calculate(request: GlideRequest): Promise<GlideResponse> {
  const controller = new AbortController(); jobs.set(request.id, controller);
  try {
    const nextKey = JSON.stringify([request.sourceKey, request.base, request.tileUrl]);
    if (!calculator || key !== nextKey) {
      calculator = new GlidePlanner(createTerrainElevationReader(request.sources, request.base, request.tileUrl)); key = nextKey;
      plannerGeneration++;
    }
    const generation = plannerGeneration;
    const { areas, airports, ...result } = await calculator.calculate(request, controller.signal);
    const planKey = `${generation}:${result.planRevision}`;
    return { ...result, planKey, airportCount: airports.length,
      ...(request.acceptedPlanKey === planKey ? {} : { plan: { areas, airports } }) };
  } finally { jobs.delete(request.id); }
}
expose({ calculate, cancel(id) { jobs.get(id)?.abort(); } } satisfies GlideWorker);
