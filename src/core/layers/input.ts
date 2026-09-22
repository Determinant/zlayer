import { createLayerStore, type LayerStore } from './store';
import { LayerScope } from './scope';

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Workspace bindings publish only committed inputs, before a lazy map attaches. */
export function createLayerInput<T extends object>() {
  const store = createLayerStore<T | undefined>(undefined);
  const require = (): T => {
    const value = store.getSnapshot();
    if (!value) throw new Error('Layer inputs have not been initialized');
    return value;
  };
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    set(value: T) { if (!shallowEqual(value, store.getSnapshot())) store.publish(value); },
    require,
    select<U>(select: (value: T) => U): LayerStore<U> {
      return selectLayerStore({ getSnapshot: require, subscribe: store.subscribe }, select);
    },
  };
}

/** A binding ignores unrelated UI changes without retaining a second state store. */
export function selectLayerStore<T, U>(store: LayerStore<T>, select: (value: T) => U): LayerStore<U> {
  let previous: U | undefined;
  let initialized = false;
  let subscribers = 0;
  const getSnapshot = (): U => {
    const next = select(store.getSnapshot());
    if (!initialized || !shallowEqual(previous, next)) { previous = next; initialized = true; }
    return previous as U;
  };
  const reset = () => { previous = undefined; initialized = false; };
  return {
    getSnapshot,
    subscribe(listener) {
      let observed: U | undefined = getSnapshot();
      const unsubscribe = store.subscribe(() => {
        const next = getSnapshot();
        if (Object.is(next, observed)) return;
        observed = next;
        listener();
      });
      subscribers++;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
        observed = undefined;
        if (--subscribers === 0) reset();
      };
    },
  };
}

/** Combine existing stores without copying their state or keeping idle subscriptions. */
export function combineLayerStores<A, B, T>(a: LayerStore<A>, b: LayerStore<B>,
  select: (a: A, b: B) => T): LayerStore<T> {
  return selectLayerStore({
    getSnapshot: () => select(a.getSnapshot(), b.getSnapshot()),
    subscribe(listener) {
      const scope = new LayerScope();
      try {
        scope.add(a.subscribe(listener));
        scope.add(b.subscribe(listener));
        return () => scope.dispose();
      } catch (error) { scope.dispose(); throw error; }
    },
  }, value => value);
}
