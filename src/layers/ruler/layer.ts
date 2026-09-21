import { createLayerStore } from '../../core/layers/store';
import { normalizeCoordinate, type Coordinate } from './measurement';

export type RulerEndpoint = 'start' | 'end';
export type RulerSnapshot = {
  active: boolean;
  start: Coordinate | null;
  end: Coordinate | null;
  provisional: boolean;
  touch: boolean;
  session: number;
};

/** A temporary measurement survives camera changes, but never restores an input mode on reload. */
export function createRulerLayer() {
  const store = createLayerStore<RulerSnapshot>({
    active: false, start: null, end: null, provisional: false, touch: false, session: 0,
  });
  const reset = (active: boolean) => store.publish({
    active, start: null, end: null, provisional: false, touch: false,
    session: store.getSnapshot().session + 1,
  });
  return {
    definition: { id: 'ruler', title: 'Ruler' },
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    open: () => reset(true),
    close: () => reset(false),
    restart: () => reset(true),
    place(coordinate: Coordinate, suggestedEnd?: Coordinate) {
      const state = store.getSnapshot(), point = normalizeCoordinate(coordinate);
      if (!state.active || !point || state.end) return;
      if (!state.start) {
        const end = suggestedEnd ? normalizeCoordinate(suggestedEnd) : null;
        store.publish({ ...state, start: point, end, touch: !!end, provisional: !!end });
      } else store.publish({ ...state, end: point, provisional: false });
    },
    move(endpoint: RulerEndpoint, coordinate: Coordinate, commit = false) {
      const state = store.getSnapshot(), point = normalizeCoordinate(coordinate);
      if (!state.active || !state[endpoint] || !point) return;
      store.publish({ ...state, [endpoint]: point,
        provisional: endpoint === 'end' && commit ? false : state.provisional });
    },
    restore(snapshot: RulerSnapshot) {
      if (store.getSnapshot().session === snapshot.session) store.publish(snapshot);
    },
    reverse() {
      const state = store.getSnapshot();
      if (!state.active || !state.start || !state.end || state.provisional) return;
      store.publish({ ...state, start: state.end, end: state.start, session: state.session + 1 });
    },
  };
}

export type RulerLayer = ReturnType<typeof createRulerLayer>;
