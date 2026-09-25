import type { Map, ImageSource, ErrorEvent } from 'maplibre-gl';
import { PROGS_COVERAGE_BOUNDS } from '@zlayer/contracts';
import type { WeatherController } from '../controller';

const SOURCE = 'weather-awc-progs-coverage';
export const COVERAGE_LAYER = `${SOURCE}-raster`;
const [west, south, east, north] = PROGS_COVERAGE_BOUNDS;
// Image sources use canonical coordinates; MapLibre supplies wrapped world copies.
const coordinates: [[number, number], [number, number], [number, number], [number, number]] =
  [[west, north], [east, north], [east, south], [west, south]];

export function mountProgsCoverageMap(map: Map, controller: WeatherController, before: string) {
  let key = '', active: AbortController | undefined, bitmap: ImageBitmap | undefined, destroyed = false;
  let retry = controller.getSnapshot().progsRetry;
  let catalog = controller.getSnapshot().coverage.snapshot;
  const hide = () => { if (map.getLayer(COVERAGE_LAYER)) map.setLayoutProperty(COVERAGE_LAYER, 'visibility', 'none'); };
  const clear = () => {
    if (map.getLayer(COVERAGE_LAYER)) map.removeLayer(COVERAGE_LAYER);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    bitmap?.close(); bitmap = undefined;
  };
  const fail = (error: unknown) => {
    active?.abort(); active = undefined; hide();
    controller.setCoverageDisplay({ loading: false, error: `Weather coverage unavailable: ${error instanceof Error ? error.message : String(error)}` });
  };
  const onError = (event: ErrorEvent & { sourceId?: string }) => {
    if (!destroyed && key && event.sourceId === SOURCE) fail(event.error);
  };
  const update = () => {
    if (destroyed) return;
    const state = controller.getSnapshot(), p = state.preferences;
    const frame = p.awcEnabled && p.awcProgs && p.awcProgsCoverage ? controller.coverageSelection() : undefined;
    const file = frame?.file, identity = file ? `${frame!.validTime}:${file.sha256}` : '';
    // A validated refresh can repair an evicted/corrupt image without changing
    // its hash. Retry failed imagery once per new live catalog, never per tick.
    const refreshed = state.coverage.snapshot !== catalog && !state.coverage.loading && !state.coverage.error && !state.coverage.restored;
    const recover = !!state.coverageDisplay.error && (retry !== state.progsRetry || refreshed);
    retry = state.progsRetry;
    catalog = state.coverage.snapshot;
    if (identity === key && !recover) return;
    key = identity; active?.abort(); active = undefined;
    hide();
    if (recover) clear();
    controller.setCoverageDisplay({ loading: !!file });
    if (!file) { clear(); return; }
    const task = active = new AbortController();
    void (async () => {
      const bytes = await controller.loadCoverage(file, task.signal);
      task.signal.throwIfAborted();
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      if (task.signal.aborted) { image.close(); return; }
      try {
        if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'image', coordinates });
        if (!map.getLayer(COVERAGE_LAYER)) map.addLayer({ id: COVERAGE_LAYER, type: 'raster', source: SOURCE,
          layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.75, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, before);
        (map.getSource(SOURCE) as ImageSource).updateImage({ image, coordinates });
        task.signal.throwIfAborted();
        bitmap?.close(); bitmap = image;
        map.setLayoutProperty(COVERAGE_LAYER, 'visibility', 'visible'); map.triggerRepaint();
        controller.setCoverageDisplay({ loading: false, validTime: frame!.validTime });
      } catch (error) { image.close(); throw error; }
    })().catch(error => { if (!task.signal.aborted) fail(error); }).finally(() => { if (active === task) active = undefined; });
  };
  map.on('error', onError);
  return { update, destroy() {
    destroyed = true; active?.abort(); map.off('error', onError); clear();
    controller.setCoverageDisplay({ loading: false });
  } };
}
