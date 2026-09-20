import { useEffect, useState } from 'react';
import { fetchMagneticModel } from './magnetic-data';
import type { MagneticModel } from './magnetic-model';

/** Load on opening, retry on reopening/reconnection, cancel when stowed or replaced. */
export function useMagneticModel(revision: string | undefined, active: boolean): MagneticModel | null {
  const [loaded, setLoaded] = useState<{ revision: string; model: MagneticModel } | null>(null);
  useEffect(() => {
    if (!active || !revision || loaded?.revision === revision) return;
    let request: AbortController | undefined;
    const load = () => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      void fetchMagneticModel(revision, controller.signal).then(model => {
        if (!controller.signal.aborted) setLoaded({ revision, model });
      }).catch(() => {}); // HSI visibly falls back to TRUE; attitude remains independent.
    };
    load();
    window.addEventListener('online', load);
    return () => { request?.abort(); window.removeEventListener('online', load); };
  }, [revision, active, loaded?.revision]);
  return loaded && loaded.revision === revision ? loaded.model : null;
}
