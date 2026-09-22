import type { Dispose } from './scope';

export type LayerEvents<T> = { subscribe(listener: (event: T) => void): Dispose };

/** Typed, synchronous notifications. New listeners start with the next event; no replay. */
export function createLayerEvents<T>(report: (error: unknown) => void = console.error) {
  const listeners = new Set<(event: T) => void>();
  const events: LayerEvents<T> = { subscribe(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  } };
  return { events, emit(event: T) {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(event); } catch (error) { report(error); }
    }
  } };
}
