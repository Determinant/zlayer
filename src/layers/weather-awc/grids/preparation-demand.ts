/** Hold speculative preparation while map/controls are changing the selection. */
export function createPreparationDemand(resume: () => void) {
  const interactions = new Set<'map' | 'controls'>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  const schedule = () => {
    clearTimeout(timer); timer = undefined;
    if (!interactions.size) timer = setTimeout(() => { timer = undefined; paused = false; resume(); }, 150);
  };
  return {
    get paused() { return paused; },
    pause() { paused = true; schedule(); },
    set(source: 'map' | 'controls', active: boolean) {
      if (active) interactions.add(source); else interactions.delete(source);
      if (interactions.size) paused = true;
      schedule();
    },
    reset() { clearTimeout(timer); timer = undefined; interactions.clear(); paused = false; },
  };
}
