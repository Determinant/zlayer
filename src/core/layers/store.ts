export type LayerStore<T> = {
  getSnapshot: () => T;
  subscribe: (listener: () => void) => () => void;
};

export function createLayerStore<T>(initial: T) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(next: T) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
