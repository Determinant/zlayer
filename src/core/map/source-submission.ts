import type { Map, GeoJSONSource, ErrorEvent } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

/** A source error can arrive before setData resolves. Own that acceptance race
 * in one place; renderers still own selection, geometry, layers and recovery. */
export function createSourceSubmission(map: Map, source: string, onFailure: (error: unknown) => void) {
  let revision = 0, active = false, failed = false, destroyed = false;
  const current = (version: number) => !destroyed && active && version === revision;
  const fail = (error: unknown) => {
    revision++; active = false; failed = true;
    onFailure(error);
  };
  const onError = (event: ErrorEvent & { sourceId?: string }) => {
    if (!destroyed && active && event.sourceId === source) fail(event.error);
  };
  map.on('error', onError);
  return {
    get failed() { return failed; },
    begin() { active = true; failed = false; return ++revision; },
    invalidate() { revision++; active = false; },
    reject(version: number, error: unknown) { if (current(version)) fail(error); },
    async submit(version: number, data: FeatureCollection): Promise<boolean> {
      if (!current(version)) return false;
      await (map.getSource(source) as GeoJSONSource).setData(data);
      return current(version);
    },
    destroy() { destroyed = true; active = false; revision++; map.off('error', onError); },
  };
}
