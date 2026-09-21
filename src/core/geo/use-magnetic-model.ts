import { useEffect, useState } from 'react';
import type { MagneticModel } from './magnetic-model';

/** Load on opening, retry on reopening/reconnection, cancel when stowed or replaced. */
export function useMagneticModel(revision: string | undefined, active: boolean,
  fetchModel: (revision: string, signal: AbortSignal) => Promise<MagneticModel>): MagneticModel | null {
  const [loaded, setLoaded] = useState<{ revision: string; model: MagneticModel } | null>(null);
  useEffect(() => {
    if (!active || !revision || loaded?.revision === revision) return;
    let request: AbortController | undefined;
    const load = () => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      void fetchModel(revision, controller.signal).then(model => {
        if (!controller.signal.aborted) setLoaded({ revision, model });
      }).catch(() => {}); // Consumers explicitly show true bearings until a magnetic reference is available.
    };
    load();
    window.addEventListener('online', load);
    return () => { request?.abort(); window.removeEventListener('online', load); };
  }, [revision, active, loaded?.revision, fetchModel]);
  return loaded && loaded.revision === revision ? loaded.model : null;
}
