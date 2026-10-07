import {
  AttributionControl,
  setWorkerUrl,
} from 'maplibre-gl';
import { Map as MapLibreMap } from '../../core/map/map';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import type { Bounds, GeoPointFeature } from '@zlayer/contracts';
import type { MapCallbacks, MapAttachment } from './inputs';
import { loadMapContribution, type MapContribution, type MapContributionContext } from '../../core/map/contribution';
import type { MapLayerModule } from '../../core/map/layer';
import { occupiedMapRegions, observeOccupiedMapRegions } from './occupied-regions';
import { CHART_LAYER_ANCHOR, PLATE_LAYER_ANCHOR, TERRAIN_LAYER_ANCHOR, WEATHER_LAYER_ANCHOR, ROUTE_LINE_ANCHOR, MapLayerHost } from '../../core/map/layer';
import { configureTouchRotation } from '../../core/map/touch-rotation';
import { DEFAULT_MAP_VIEW, mapStyle, type MapView } from './style';
import { mapErrorMessage, MapTileErrors } from './errors';
import { createViewReporter } from './view-reporter';
import { MapNavigationControl } from './navigation-control';
import { LayerScope } from '../../core/layers/scope';
import { resourceErrorCode } from '../../core/data/errors';

// MapLibre's default relative worker URL is not emitted by Vite's app bundler.
// Bundle the worker (and its shared imports) explicitly for production/offline use.
setWorkerUrl(mapWorkerUrl);

type ContributionAttachment = { controller: AbortController; modules?: readonly MapLayerModule<void>[] };

type MapRuntimeOptions = MapCallbacks & MapAttachment & { container: HTMLElement; initialView?: MapView };

// MapLibre starts compact attribution expanded. Set its initial disclosure state
// here; the control retains its own toggle, source updates, and resize handling.
class CollapsedAttributionControl extends AttributionControl {
  override onAdd(map: MapLibreMap): HTMLElement {
    const container = super.onAdd(map);
    container.classList.remove('maplibregl-compact-show');
    container.removeAttribute('open');
    return container;
  }
}

export class MapRuntime {
  readonly #map: MapLibreMap;
  readonly #navigation: MapNavigationControl;
  #styleReady = false;
  #contributions: readonly MapContribution[] | undefined;
  readonly #attachments = new Map<MapContribution, ContributionAttachment>();
  readonly #context: Omit<MapContributionContext, 'signal' | 'preserveView'>;
  readonly #scope = new LayerScope();
  readonly #layerHost: MapLayerHost;
  readonly #onError: MapRuntimeOptions['onError'];
  readonly #reportIdle: (idle: boolean) => void;

  constructor(options: MapRuntimeOptions) {
    this.#onError = options.onError;

    // MapLibre observes and throttles container resizes itself. A second
    // observer or initial resize would repeat writes to the canvas backing size.
    try {
      this.#map = new MapLibreMap({
        container: options.container,
        style: mapStyle(),
        ...(options.initialView ?? DEFAULT_MAP_VIEW),
        minZoom: 3,
        maxZoom: 13,
        attributionControl: false,
        fadeDuration: 0,
      });
      this.#scope.add(() => this.#map.remove());
      const { onIdleChange } = options;
      let idle = false;
      this.#reportIdle = value => { if (value !== idle) { idle = value; onIdleChange?.(value); } };
      this.#map.on('idle', () => {
        if ([...this.#attachments.values()].every(attachment => attachment.modules)) this.#reportIdle(true);
      });
      this.#map.on('dataloading', () => this.#reportIdle(false));
      this.#map.on('movestart', () => this.#reportIdle(false));
      configureTouchRotation(this.#map.touchZoomRotate);
      this.#layerHost = new MapLayerHost(this.#map, (id, error) => {
        this.#onError(`${id}: ${error instanceof Error ? error.message : 'Layer unavailable'}`, resourceErrorCode(error));
      }, () => { this.#reportIdle(false); this.#map.triggerRepaint(); });
      this.#scope.add(() => this.#layerHost.unmount());
      this.#navigation = new MapNavigationControl(options.orientation);
      this.#map.addControl(this.#navigation, 'top-right');
      this.#map.addControl(
        new CollapsedAttributionControl({ compact: true, customAttribution: 'FAA aeronautical data' }),
        'bottom-right',
      );

      const tileErrors = new MapTileErrors();
      const { onErrorRecovered } = options;
      const recovered = (sourceId: string | undefined) => { if (sourceId !== undefined) onErrorRecovered?.(sourceId); };
      const clearErrors = () => { for (const sourceId of tileErrors.clear()) recovered(sourceId); };
      this.#scope.add(clearErrors);
      this.#map.on('style.load', () => {
        clearErrors();
        this.#layerHost.unmount();
        this.#styleReady = true;
        this.#installLayers();
      });
      this.#map.on('error', (event) => {
        const message = mapErrorMessage(event);
        if (message) {
          const resource = tileErrors.failed(event, message);
          this.#onError(message, resourceErrorCode(event.error), resource);
        }
        // A terminal tile error can settle a source after its last render. Ask
        // for the final frame/idle event so offline startup cannot stay "busy".
        if (!idle) this.#map.triggerRepaint();
      });
      this.#map.on('sourcedata', event => {
        // MapLibre reports source removal as metadata after deleting getSource's
        // entry, before disconnecting tile events. Retire that source's condition
        // here so a same-ID replacement cannot inherit failed tiles.
        recovered(event.sourceDataType === 'metadata' && event.sourceId && !this.#map.getSource(event.sourceId)
          ? tileErrors.removeSource(event.sourceId) : tileErrors.loaded(event));
      });
      this.#map.on('sourcedataabort', event => {
        recovered(tileErrors.removed(event));
      });
      this.#context = {
        map: this.#map,
        interactiveLayerIds: () => this.#layerHost.interactiveLayerIds(),
        occupiedRects: () => occupiedMapRegions(options.container),
        observeOccupiedRects: changed => observeOccupiedMapRegions(options.container, changed),
        targetBearing: () => this.#navigation.getTargetBearing(),
        run: (id, action) => this.#layerHost.run(id, action),
        reportError: error => this.#onError(error instanceof Error ? error.message : 'Layer unavailable', resourceErrorCode(error)),
      };
      // Long-lived camera listeners need callbacks, not the initial input object
      // (which also holds a catalog, route and national navigation collections).
      const { onViewportChange, onViewChange } = options;
      let previousViewport: Bounds | undefined;
      const reportViewport = () => {
        const bounds = this.#map.getBounds();
        const viewport: Bounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
        if (previousViewport?.every((value, index) => value === viewport[index])) return;
        previousViewport = viewport;
        onViewportChange(viewport);
      };
      const viewReporter = createViewReporter(() => ({
        center: [this.#map.getCenter().lng, this.#map.getCenter().lat],
        zoom: this.#map.getZoom(), bearing: this.#map.getBearing(), pitch: this.#map.getPitch(),
      }), view => onViewChange?.(view));
      window.addEventListener('pagehide', viewReporter.flush);
      this.#scope.add(() => window.removeEventListener('pagehide', viewReporter.flush));
      document.addEventListener('visibilitychange', viewReporter.flush);
      this.#scope.add(() => document.removeEventListener('visibilitychange', viewReporter.flush));
      this.#scope.add(viewReporter.flush);
      this.#map.on('moveend', event => {
        if (this.#scope.signal.aborted) return;
        reportViewport();
        viewReporter.report((event as typeof event & { gpsCamera?: boolean }).gpsCamera === true);
      });
      this.#map.on('resize', reportViewport);
      this.#scope.add(() => {
        for (const attachment of this.#attachments.values()) attachment.controller.abort();
        this.#attachments.clear();
      });
      this.setContributions(options.contributions, !!options.initialView);
      reportViewport();
      viewReporter.flush();
    } catch (error) {
      this.#scope.dispose();
      throw error;
    }
  }

  /** Reconcile on the existing map; unrelated adapters keep their live resources. */
  setContributions(contributions: readonly MapContribution[], preserveView = true): void {
    if (this.#scope.signal.aborted || this.#contributions === contributions) return;
    this.#contributions = contributions;
    for (const [contribution, attachment] of this.#attachments) {
      if (contributions.includes(contribution)) continue;
      attachment.controller.abort();
      this.#attachments.delete(contribution);
    }
    this.#reportIdle(false);
    // Remove unloaded plugins immediately, before waiting for any imports.
    this.#installLayers();
    for (const contribution of contributions) {
      if (this.#attachments.has(contribution)) continue;
      const attachment: ContributionAttachment = { controller: new AbortController() };
      this.#attachments.set(contribution, attachment);
      const { signal } = attachment.controller;
      // Each import settles independently. A stalled addition cannot block its peers.
      void loadMapContribution(contribution, { ...this.#context, signal, preserveView }).then(modules => {
        if (signal.aborted || this.#attachments.get(contribution) !== attachment) return;
        attachment.modules = modules;
        this.#installLayers();
      }).catch(error => { if (!signal.aborted) this.#onError(String(error)); });
    }
  }

  focus(feature: GeoPointFeature): void {
    this.#map.flyTo({ center: feature.geometry.coordinates, zoom: 10.5, duration: 650 });
  }

  destroy(): void { this.#scope.dispose(); }

  #installLayers(): void {
    if (!this.#styleReady || this.#scope.signal.aborted) return;
    // Keep terrain visible above plates, including when either layer is refreshed.
    for (const id of [CHART_LAYER_ANCHOR, PLATE_LAYER_ANCHOR, TERRAIN_LAYER_ANCHOR, WEATHER_LAYER_ANCHOR, ROUTE_LINE_ANCHOR]) {
      if (!this.#map.getLayer(id)) this.#map.addLayer({
        id, type: 'background', paint: { 'background-opacity': 0 },
      });
    }
    const modules = (this.#contributions ?? []).flatMap(contribution => this.#attachments.get(contribution)?.modules ?? []);
    this.#layerHost.reconcile(modules);
    this.#reportIdle(false);
    this.#map.triggerRepaint();
  }
}
