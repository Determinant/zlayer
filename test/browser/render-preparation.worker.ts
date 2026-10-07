// Benchmark-only copy-cost experiment; no application worker or cache.
import { isRadarContours, isSurfaceArtifact } from '@zlayer/contracts';
import { preparedJson } from '../../src/layers/weather-awc/prepared-file';
import { stitchTerrainContours } from '../../src/layers/terrain/seams';

self.onmessage = async ({ data }) => {
  try {
    const start = performance.now();
    const value = data.name === 'terrain' ? stitchTerrainContours(data.lines, data.borders, data.segments)
      : await preparedJson(data.bytes, data.sha256);
    if (data.name !== 'terrain' && !(data.name === 'radar' ? isRadarContours(value) : isSurfaceArtifact(value))) throw new Error('Invalid fixture');
    self.postMessage({ value, workMs: performance.now() - start });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
