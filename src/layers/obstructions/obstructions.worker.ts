import { expose } from 'comlink';
import { loadObstructions } from './api';
import type { ObstructionWorker } from './types';

let current: { url: string; loading: ReturnType<typeof loadObstructions> } | undefined;
expose({
  async query({ manifestUrl, bounds, segments, zoom }) {
    if (!current || current.url !== manifestUrl) {
      const loading = loadObstructions(manifestUrl);
      current = { url: manifestUrl, loading };
      void loading.catch(() => { if (current?.loading === loading) current = undefined; });
    }
    const { index, sourceDate } = await current.loading;
    return { collection: index.query(bounds, segments, zoom), ...(sourceDate ? { sourceDate } : {}) };
  },
} satisfies ObstructionWorker);
