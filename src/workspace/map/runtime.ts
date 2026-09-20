import {
  AttributionControl,
  LngLatBounds,
  Map as MapLibreMap,
  setWorkerUrl,
} from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import type { Bounds, GeoPointFeature } from '@zlayer/contracts';
import type { MapInputs, MapCallbacks, MapAttachment } from './inputs';
import { createBuiltInMapLayers } from './registry';
import { CHART_LAYER_ANCHOR, TERRAIN_LAYER_ANCHOR, ROUTE_LINE_ANCHOR, MapLayerHost } from '../../core/map/layer';
import { MapGestures } from './gestures';
import { configureTouchRotation } from '../../core/map/touch-rotation';
import { unwrapRouteCoordinates } from '../../layers/routes/geometry';
import { DEFAULT_MAP_VIEW, mapStyle, type MapView } from './style';
import { mapErrorMessage } from './errors';
import { MapNavigationControl } from './navigation-control';
import { resourceErrorCode } from '../../core/data/errors';

// MapLibre's default relative worker URL is not emitted by Vite's app bundler.
// Bundle the worker (and its shared imports) explicitly for production/offline use.
setWorkerUrl(mapWorkerUrl);

type MapRuntimeOptions = MapInputs & MapCallbacks & MapAttachment & { container: HTMLElement; initialView?: MapView };

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
  readonly #layers: ReturnType<typeof createBuiltInMapLayers>;
  readonly #layerHost: MapLayerHost;
  readonly #onReady: MapRuntimeOptions['onReady'];
  readonly #onError: MapRuntimeOptions['onError'];
  #inputs: MapInputs;
  #routeReady = false;
  readonly #gestures: MapGestures;
  readonly #saveView: () => void;

  constructor(options: MapRuntimeOptions) {
    this.#inputs = options;
    this.#layers = createBuiltInMapLayers(options.catalog, options.metarLayer, options.onTerrainStatus, options.ownshipLayer,
      !!options.initialView && options.ownshipEnabled, options.onObstructionStatus);
    this.#onReady = options.onReady;
    this.#onError = options.onError;

    // MapLibre observes and throttles container resizes itself. A second
    // observer or initial resize would repeat writes to the canvas backing size.
    this.#map = new MapLibreMap({
      container: options.container,
      style: mapStyle(),
      ...(options.initialView ?? DEFAULT_MAP_VIEW),
      minZoom: 3,
      maxZoom: 13,
      attributionControl: false,
      fadeDuration: 0,
    });
    configureTouchRotation(this.#map.touchZoomRotate);
    this.#layerHost = new MapLayerHost(this.#map, (id, error) => {
      this.#onError(`${id}: ${error instanceof Error ? error.message : 'Layer unavailable'}`, resourceErrorCode(error));
    });
    this.#navigation = new MapNavigationControl(options.ownshipLayer);
    this.#map.addControl(this.#navigation, 'top-right');
    this.#map.addControl(
      new CollapsedAttributionControl({ compact: true, customAttribution: 'FAA aeronautical data' }),
      'bottom-right',
    );

    this.#map.on('style.load', () => this.#installLayers());
    this.#map.on('error', (event) => {
      const message = mapErrorMessage(event);
      if (message) this.#onError(message, resourceErrorCode(event.error));
    });
    this.#gestures = new MapGestures(this.#map, {
      route: () => this.#inputs.route,
      canEditRoute: () => !this.#inputs.recommendations,
      interactiveLayerIds: () => this.#layerHost.interactiveLayerIds(),
      preview: input => this.#layerHost.update(this.#layers.route, input),
      onSelect: options.onSelect,
      ...(options.onChooseNearby ? { onChooseNearby: options.onChooseNearby } : {}),
      onRouteLegInsert: options.onRouteLegInsert,
      onRouteWaypointReplace: options.onRouteWaypointReplace,
      onRouteWaypointRemove: options.onRouteWaypointRemove,
    });
    let previousViewport: Bounds | undefined;
    const reportViewport = () => {
      const bounds = this.#map.getBounds();
      const viewport: Bounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      if (previousViewport?.every((value, index) => value === viewport[index])) return;
      previousViewport = viewport;
      options.onViewportChange(viewport);
    };
    let previousView: MapView | undefined;
    const reportView = () => {
      const view: MapView = {
        center: [this.#map.getCenter().lng, this.#map.getCenter().lat],
        zoom: this.#map.getZoom(),
        bearing: this.#map.getBearing(),
        pitch: this.#map.getPitch(),
      };
      if (previousView?.center.every((value, index) => value === view.center[index]) && previousView.zoom === view.zoom
        && previousView.bearing === view.bearing && previousView.pitch === view.pitch) return;
      previousView = view;
      options.onViewChange?.(view);
    };
    this.#saveView = reportView;
    window.addEventListener('pagehide', reportView);
    document.addEventListener('visibilitychange', reportView);
    this.#map.on('moveend', () => { reportViewport(); reportView(); });
    this.#map.on('resize', reportViewport);
    reportViewport();
    reportView();
  }

  update(inputs: MapInputs): void {
    const previous = this.#inputs;
    const chartsChanged = inputs.catalog !== previous.catalog ||
      inputs.chartSelection.base !== previous.chartSelection.base || inputs.chartSelection.overlay !== previous.chartSelection.overlay;
    const navigationChanged = inputs.data !== previous.data || inputs.visibility !== previous.visibility ||
      inputs.fixContext !== previous.fixContext || inputs.metarEnabled !== previous.metarEnabled;
    const recommendationsChanged = inputs.recommendations !== previous.recommendations;
    const cameraKey = (value: MapInputs['recommendations']) => JSON.stringify([value?.routes.map(route => route.key), value?.inset]);
    const refit = recommendationsChanged && (cameraKey(previous.recommendations) !== cameraKey(inputs.recommendations) ||
      Boolean(previous.recommendations?.preserveView && !inputs.recommendations?.preserveView));
    if (inputs.route.revision !== previous.route.revision || (recommendationsChanged && inputs.recommendations)) {
      this.#gestures.cancelRouteDrag();
    }
    this.#inputs = inputs;
    if (chartsChanged) this.#updateChartLayers();
    if (navigationChanged) this.#updateNavigationLayers();
    if (inputs.route !== previous.route || recommendationsChanged) this.#updateRouteLayer();
    if (inputs.identification !== previous.identification) {
      this.#layerHost.update(this.#layers.identification, inputs.identification);
    }
    if (inputs.route !== previous.route || recommendationsChanged || inputs.terrainEnabled !== previous.terrainEnabled
      || inputs.terrainAltitude !== previous.terrainAltitude) this.#updateTerrainLayer();
    if (inputs.route !== previous.route || recommendationsChanged
      || inputs.obstructionsEnabled !== previous.obstructionsEnabled) this.#updateObstructionLayer();
    if (inputs.recommendations && !inputs.recommendations.preserveView && refit && this.#routeReady) this.fitRoute();
    if (inputs.ownshipEnabled !== previous.ownshipEnabled) {
      this.#layerHost.update(this.#layers.ownship, { enabled: inputs.ownshipEnabled });
    }
  }

  #updateChartLayers(): void {
    for (const layer of this.#layers.charts) this.#layerHost.update(layer, {
      catalog: this.#inputs.catalog, selection: this.#inputs.chartSelection,
    });
  }

  #updateRouteLayer(): void {
    this.#layerHost.update(this.#layers.route, { route: this.#inputs.route,
      ...(this.#inputs.recommendations ? { recommendations: this.#inputs.recommendations } : {}) });
  }

  #updateTerrainLayer(): void {
    this.#layerHost.update(this.#layers.terrain, { enabled: this.#inputs.terrainEnabled, altitude: this.#inputs.terrainAltitude,
      routes: this.#inputs.recommendations?.routes.map(route => route.plan) ?? [this.#inputs.route] });
  }

  #updateObstructionLayer(): void {
    this.#layerHost.update(this.#layers.obstructions, { enabled: this.#inputs.obstructionsEnabled,
      routes: this.#inputs.recommendations?.routes.map(route => route.plan) ?? [this.#inputs.route] });
  }

  focus(feature: GeoPointFeature): void {
    this.#map.flyTo({ center: feature.geometry.coordinates, zoom: 10.5, duration: 650 });
  }

  fitRoute(): void {
    const plans = this.#inputs.recommendations?.routes.map(route => route.plan) ?? [this.#inputs.route];
    const coordinates = plans.flatMap(plan => unwrapRouteCoordinates(
      plan.waypoints.map(waypoint => waypoint.feature.geometry.coordinates), this.#map.getCenter().lng));
    const first = coordinates[0];
    if (!first) return;
    const bearing = this.#navigation.getTargetBearing();
    if (coordinates.length === 1) {
      this.#map.flyTo({ center: first, zoom: 10.5, bearing, duration: 500 });
      return;
    }
    const bounds = coordinates.slice(1).reduce(
      (current, coordinate) => current.extend(coordinate),
      new LngLatBounds(first, first),
    );
    const inset = this.#inputs.recommendations?.inset;
    const container = this.#map.getContainer();
    const padding = inset ? { top: 36, left: 36,
      right: 36 + Math.min(inset.right, Math.max(0, container.clientWidth - 144)),
      bottom: 36 + Math.min(inset.bottom, Math.max(0, container.clientHeight - 144)) } : 72;
    this.#map.fitBounds(bounds, { padding, bearing, maxZoom: 10.5, duration: 550 });
  }

  destroy(): void {
    this.#saveView();
    window.removeEventListener('pagehide', this.#saveView);
    document.removeEventListener('visibilitychange', this.#saveView);
    this.#gestures.destroy();
    this.#layerHost.unmount();
    this.#map.remove();
  }

  #updateNavigationLayers(): void {
    this.#layerHost.update(this.#layers.navigation, {
      data: this.#inputs.data, visibility: this.#inputs.visibility, ...this.#inputs.fixContext,
    });
    this.#layerHost.update(this.#layers.metar, {
      airports: this.#inputs.data.airports, enabled: this.#inputs.metarEnabled, airportsVisible: this.#inputs.visibility.airports,
    });
  }

  #installLayers(): void {
    for (const id of [CHART_LAYER_ANCHOR, TERRAIN_LAYER_ANCHOR, ROUTE_LINE_ANCHOR]) {
      if (!this.#map.getLayer(id)) this.#map.addLayer({
        id, type: 'background', paint: { 'background-opacity': 0 },
      });
    }
    this.#onReady();
    this.#updateChartLayers();
    this.#updateNavigationLayers();
    this.#updateRouteLayer();
    this.#updateTerrainLayer();
    this.#updateObstructionLayer();
    this.#layerHost.update(this.#layers.identification, this.#inputs.identification);
    this.#layerHost.update(this.#layers.ownship, { enabled: this.#inputs.ownshipEnabled });
    this.#layerHost.mount(this.#layers.modules);
    this.#routeReady = true;
    if (this.#inputs.recommendations && !this.#inputs.recommendations.preserveView) this.fitRoute();
  }
}
