import { loadObstructions, type LoadedObstructions } from './api';
import type { ObstructionWorker } from './types';

/** One validated national index; revalidation replaces it only after success. */
export function createObstructionWorker(load = loadObstructions): ObstructionWorker {
  let current: { url: string; data: LoadedObstructions } | undefined;
  let pending: { url: string; promise: Promise<LoadedObstructions> } | undefined;
  return {
    async query({ manifestUrl, bounds, segments, zoom, revalidate }) {
      if (!pending || pending.url !== manifestUrl) {
        if (revalidate || current?.url !== manifestUrl) {
          const job: NonNullable<typeof pending> = { url: manifestUrl, promise: Promise.resolve().then(() =>
            load(manifestUrl, current?.url === manifestUrl ? current.data : undefined)).then(data => {
              if (pending === job) current = { url: manifestUrl, data };
              return data;
            }).finally(() => { if (pending === job) pending = undefined; }) };
          pending = job;
        }
      }
      const { index, sourceDate } = pending?.url === manifestUrl ? await pending.promise : current!.data;
      return { collection: index.query(bounds, segments, zoom), ...(sourceDate ? { sourceDate } : {}) };
    },
  };
}
