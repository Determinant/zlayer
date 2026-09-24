import { parentPort } from 'node:worker_threads';
import { prepareRadar, type ScanWindow } from './radar-decode';
parentPort!.on('message', ({ raw, site, source, sourceHash, window }: { raw: ArrayBuffer; site: string; source: string; sourceHash: string; window: ScanWindow }) => {
  try {
    const value = prepareRadar(Buffer.from(raw), site, source, sourceHash, window);
    const body = new TextEncoder().encode(JSON.stringify(value)).buffer;
    parentPort!.postMessage({ value: { body, scan: { site, source, sourceHash, observedAt: value.observedAt, bounds: value.bounds } } }, [body]);
  } catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
