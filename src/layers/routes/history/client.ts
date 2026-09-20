import type { Remote } from 'comlink';
import type { RouteHistoryResource } from '@zlayer/contracts';
import type { RouteHistoryQuery } from '@zlayer/domain';
import type { RouteHistoryStore } from './store';
import { WorkerClient } from '../../../core/data/worker-client';

let client: WorkerClient<RouteHistoryStore> | undefined;

function createClient(): WorkerClient<RouteHistoryStore> {
  const worker = new Worker(new URL('./route-history.worker.ts', import.meta.url), { type: 'module' });
  return new WorkerClient<RouteHistoryStore>(worker, 'Could not start the route history reader. Reload the app and retry.');
}

async function call<T>(request: (remote: Remote<RouteHistoryStore>) => Promise<T>): Promise<T> {
  if (!client || client.retired) client = createClient();
  return client.call(request);
}

export const queryRouteHistory = (resource: RouteHistoryResource, revision: string, query: RouteHistoryQuery) =>
  call(remote => remote.query(resource, revision, query));
export async function prepareRouteHistory(resource: RouteHistoryResource, revision: string, signal: AbortSignal) {
  signal.throwIfAborted();
  // Preparation owns its worker so pausing can stop fetch and synchronous validation,
  // without interrupting route-history queries in the shared reader.
  const preparer = createClient();
  const abort = () => preparer.dispose();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await preparer.call(remote => remote.prepare(resource, revision));
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    preparer.dispose();
  }
}
export const isRouteHistoryCached = (resource: RouteHistoryResource, revision: string) =>
  call(remote => remote.cached(resource, revision));
