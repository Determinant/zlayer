import type { Remote } from 'comlink';
import type { RouteHistoryResource } from '@zlayer/contracts';
import type { RouteHistoryQuery } from '@zlayer/domain';
import type { RouteHistoryStore } from './store';
import { WorkerClient } from '../../../core/data/worker-client';
import { withAbort } from '../../../core/data/abort';

let client: WorkerClient<RouteHistoryStore> | undefined;
const consumers = new Set<symbol>();

/** Keep the index warm while a suggestions view uses it; construction stays lazy. */
export function retainRouteHistory(): () => void {
  const consumer = Symbol();
  consumers.add(consumer);
  return () => {
    if (!consumers.delete(consumer) || consumers.size) return;
    client?.dispose(); client = undefined;
  };
}

function createClient(): WorkerClient<RouteHistoryStore> {
  const worker = new Worker(new URL('./route-history.worker.ts', import.meta.url), { type: 'module' });
  return new WorkerClient<RouteHistoryStore>(worker, 'Could not start the route history reader. Reload the app and retry.');
}

async function call<T>(request: (remote: Remote<RouteHistoryStore>) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const release = retainRouteHistory();
  try {
    if (!client || client.retired) client = createClient();
    const result = client.call(request);
    return await (signal ? withAbort(result, signal) : result);
  } finally { release(); }
}

export const queryRouteHistory = (resource: RouteHistoryResource, revision: string, query: RouteHistoryQuery, signal?: AbortSignal) =>
  call(remote => remote.query(resource, revision, query), signal);
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
