import type { MapView } from './style';

const GPS_SAVE_INTERVAL_MS = 2000;

/** Bound automatic camera writes while preserving immediate user/lifecycle saves. */
export function createViewReporter(read: () => MapView, save: (view: MapView) => void) {
  let previous: MapView | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    const view = read();
    if (previous?.center.every((value, index) => value === view.center[index]) && previous.zoom === view.zoom
      && previous.bearing === view.bearing && previous.pitch === view.pitch) return;
    previous = view;
    save(view);
  };
  return {
    flush,
    report(automatic = false) {
      if (!automatic) { flush(); return; }
      // A fixed deadline, not a debounce: continuous flight still gets saved.
      timer ??= setTimeout(flush, GPS_SAVE_INTERVAL_MS);
    },
  };
}
