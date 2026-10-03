import { withAbort } from '../data/abort';

export type PluginFileResult<T> = { value: T; saved: boolean };
type Pending = { controller: AbortController; users: number; result: Promise<unknown>;
  ready?: { value: unknown }; listeners: Set<(value: unknown) => void> };
const pending = new Map<string, Pending>();

/** Share only in-flight work; each consumer owns its cancellation and readiness observer. */
export async function shareFileRequest<T>(key: string, signal: AbortSignal, onReady: ((value: T) => void) | undefined,
  work: (signal: AbortSignal, ready: (value: T) => void) => Promise<PluginFileResult<T>>): Promise<PluginFileResult<T>> {
  let task = pending.get(key);
  if (!task) {
    const controller = new AbortController();
    const current: Pending = { controller, users: 0, listeners: new Set(), result: Promise.resolve().then(() => work(controller.signal, value => {
      if (controller.signal.aborted || current.ready) return;
      current.ready = { value };
      for (const listener of current.listeners) listener(value);
    })) };
    task = current; pending.set(key, task);
    void task.result.finally(() => { if (pending.get(key) === current) pending.delete(key); }).catch(() => {});
  }
  task.users++;
  // A failed observer cannot invalidate authenticated bytes or another caller's save.
  const listener = (value: unknown) => { if (!signal.aborted) { try { onReady?.(value as T); } catch { /* Observer only. */ } } };
  task.listeners.add(listener);
  if (task.ready) listener(task.ready.value);
  try { return await withAbort(task.result as Promise<PluginFileResult<T>>, signal); }
  finally {
    task.listeners.delete(listener);
    if (--task.users === 0) {
      if (pending.get(key) === task) pending.delete(key);
      task.controller.abort();
    }
  }
}
