import type { Map as MapLibreMap, MapEventType, MapGeoJSONFeature, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';
import type { GeoPointFeature } from '@zlayer/contracts';
import { featureKey, sameFeature, routeCoordinateFeature, restoreRouteCoordinate, type RouteEditTarget, type RoutePlan } from '@zlayer/domain';
import { ROUTE_LEG_HIT_LAYER_ID, ROUTE_WAYPOINT_HIT_LAYER_ID, ROUTE_SOURCE_ID, type RouteDragPreview } from '../../layers/routes/renderer';
import { routeEditTarget } from '../../layers/routes/editing';
import { routePointKeys } from '../../layers/routes/selection';
import { unwrapRouteCoordinates } from '../../layers/routes/geometry';
import { routeSnapFeature, ROUTE_SNAP_RADIUS_PX, type RouteSnap } from '../../layers/routes/snapping';
import type { NearbyFeature, SelectFeature } from '../feature-selection';
import { renderedSnapBounds } from './snap-bounds';

type GestureOptions = {
  toolActive?: () => boolean;
  route: () => RoutePlan;
  canEditRoute: () => boolean;
  interactiveLayerIds: () => string[];
  resolveFeature?: (feature: GeoPointFeature) => GeoPointFeature;
  preview: (input: { route: RoutePlan; preview?: RouteDragPreview }) => void;
  onSelect: SelectFeature;
  onContextAction?: (point: { x: number; y: number }) => boolean;
  onChooseNearby?: (features: NearbyFeature[], point: { x: number; y: number }) => void;
  onRouteLegInsert: (afterEntryId: string, feature: GeoPointFeature) => void;
  onRouteWaypointReplace: (entryId: string, feature: GeoPointFeature) => void;
  onRouteWaypointRemove: (entryId: string) => void;
};

type RouteDragState = {
  target: RouteEditTarget;
  revision: number;
  pointer: 'mouse' | 'touch';
  excludedFeatures: GeoPointFeature[];
  snap: RouteSnap | undefined;
  coordinate: GeoPointFeature | undefined;
  allowCoordinateDrop: boolean;
  dragPanWasEnabled: boolean;
  touchZoomWasEnabled: boolean;
  startPoint: [number, number];
  lastPoint: [number, number];
  distancePx: number;
  active: boolean;
};

const DRAG_THRESHOLD_PX = 6;
const REMOVE_DISTANCE_PX = 28;
const NEARBY_RADIUS_PX = 30;
const LONG_PRESS_MS = 550;

export class MapGestures {
  readonly #map: MapLibreMap;
  #routeDrag: RouteDragState | undefined;
  #suppressClick = false;
  #suppressClickTimer: number | undefined;
  #nearbyLongPress: { point: [number, number]; timer: number } | undefined;
  #contextMenuHandledUntil = 0;
  #longPressHandled = false;
  readonly #unbind: Array<() => void> = [];

  constructor(map: MapLibreMap, private readonly options: GestureOptions) {
    this.#map = map;
    const on = <T extends keyof MapEventType>(type: T, listener: (event: MapEventType[T]) => void) => {
      map.on(type, listener);
      this.#unbind.push(() => { map.off(type, listener); });
    };
    // A new physical press starts a new click sequence. Compatibility mouse
    // events after a touch release do not emit another pointerdown.
    const canvas = map.getCanvas();
    const pointerDown = (event: PointerEvent) => {
      if (event.isPrimary && event.button === 0) this.#clearClickSuppression();
    };
    canvas.addEventListener('pointerdown', pointerDown);
    this.#unbind.push(() => canvas.removeEventListener('pointerdown', pointerDown));
    on('click', (event) => this.#selectFeature(event));
    on('contextmenu', (event) => {
      event.preventDefault();
      this.#cancelNearbyLongPress();
      if (Date.now() < this.#contextMenuHandledUntil) return;
      this.#contextAction(event.point);
    });
    on('mousedown', (event) => this.#startRouteDrag(event));
    on('touchstart', (event) => { this.#startRouteDrag(event); this.#startNearbyLongPress(event); });
    on('mousemove', (event) => {
      this.#updateRouteDrag(event);
      this.#setPointerCursor(event);
    });
    on('touchmove', (event) => { this.#updateRouteDrag(event); this.#cancelNearbyLongPressIfMoved(event); });
    on('mouseup', (event) => this.#endRouteDrag(event));
    // MapLibre's touchend points are changedTouches, not the remaining touches.
    on('touchend', (event) => {
      this.#endRouteDrag(event);
      this.#cancelNearbyLongPress();
      if (this.#longPressHandled) {
        // The compatibility mouse events from this release would steal focus
        // from the new menu or activate a control underneath the finger.
        if (event.originalEvent.cancelable) event.originalEvent.preventDefault();
        this.#suppressNextClick();
        this.#contextMenuHandledUntil = Date.now() + 400;
        this.#longPressHandled = false;
      }
    });
    on('touchcancel', event => this.#finishDragOutsideMap(event.originalEvent));
    window.addEventListener('mouseup', this.#finishDragOutsideMap);
    window.addEventListener('touchend', this.#finishDragOutsideMap);
    window.addEventListener('touchcancel', this.#finishDragOutsideMap);
    window.addEventListener('blur', this.#cancelGesture);
    window.addEventListener('keydown', this.#cancelOnEscape);
  }

  get dragging(): boolean { return this.#routeDrag !== undefined; }
  cancelInteractions(): void { this.#cancelGesture(); }
  cancelRouteDrag(): void {
    if (!this.#routeDrag) return;
    this.#finishRouteDrag(false);
    this.#cancelNearbyLongPress();
  }

  destroy(): void {
    this.#cancelGesture();
    for (const unbind of this.#unbind.splice(0)) unbind();
    if (this.#suppressClickTimer !== undefined) window.clearTimeout(this.#suppressClickTimer);
    window.removeEventListener('mouseup', this.#finishDragOutsideMap);
    window.removeEventListener('touchend', this.#finishDragOutsideMap);
    window.removeEventListener('touchcancel', this.#finishDragOutsideMap);
    window.removeEventListener('blur', this.#cancelGesture);
    window.removeEventListener('keydown', this.#cancelOnEscape);
  }

  #selectFeature(event: MapMouseEvent): void {
    if (this.options.toolActive?.()) return;
    if (this.#suppressClick) {
      this.#clearClickSuppression();
      return;
    }
    const features = this.#map.queryRenderedFeatures(event.point, {
      layers: this.options.interactiveLayerIds(),
    });
    const feature = features.find(isPointFeature);
    const pointId = feature?.source === ROUTE_SOURCE_ID && typeof feature.properties.routePointId === 'string'
      ? feature.properties.routePointId : undefined;
    this.options.onSelect(feature ? this.#resolveFeature(feature) : undefined, pointId);
  }

  #showNearby(point: MapMouseEvent['point']): void {
    const nearby: NearbyFeature[] = [];
    const coordinate = this.#map.unproject(point);
    const longitude = coordinate.lng;
    const pointKeys = routePointKeys(this.options.route());
    for (const [routeIndex, waypoint] of this.options.route().waypoints.entries()) {
      if (this.#featureDistance(waypoint.feature, point, longitude) <= NEARBY_RADIUS_PX) {
        nearby.push({ feature: waypoint.feature, routePointId: pointKeys.get(waypoint)!, routeIndex });
      }
    }
    const features = this.#map.queryRenderedFeatures([
      [point.x - NEARBY_RADIUS_PX, point.y - NEARBY_RADIUS_PX],
      [point.x + NEARBY_RADIUS_PX, point.y + NEARBY_RADIUS_PX],
    ], { layers: this.options.interactiveLayerIds() })
      .filter(isPointFeature)
      .map(feature => this.#resolveFeature(feature));
    const unique = new Map<string, GeoPointFeature>();
    for (const feature of features) {
      if (nearby.some(candidate => sameFeature(candidate.feature, feature))) continue;
      unique.set(featureKey(feature), feature);
    }
    nearby.push(...[...unique.values()].map(feature => ({ feature })));
    if ((nearby.length > 1 || nearby[0]?.routeIndex !== undefined) && this.options.onChooseNearby) {
      this.options.onChooseNearby(nearby, { x: point.x, y: point.y });
    } else this.options.onSelect(nearby[0]?.feature ?? routeCoordinateFeature([longitude, coordinate.lat]), nearby[0]?.routePointId);
  }

  #contextAction(point: MapMouseEvent['point']): void {
    if (this.options.toolActive?.()) return;
    this.cancelRouteDrag();
    if (!this.options.onContextAction?.(point)) this.#showNearby(point);
  }

  #startNearbyLongPress(event: MapTouchEvent): void {
    this.#cancelNearbyLongPress();
    this.#longPressHandled = false;
    if (this.options.toolActive?.()) return;
    if (event.points.length !== 1) return;
    const point: [number, number] = [event.point.x, event.point.y];
    const timer = window.setTimeout(() => {
      this.#nearbyLongPress = undefined;
      this.#longPressHandled = true;
      this.#contextMenuHandledUntil = Date.now() + 1000;
      this.#contextAction({ x: point[0], y: point[1] } as MapMouseEvent['point']);
      this.#suppressNextClick();
    }, LONG_PRESS_MS);
    this.#nearbyLongPress = { point, timer };
  }

  #cancelNearbyLongPressIfMoved(event: MapTouchEvent): void {
    const pending = this.#nearbyLongPress;
    if (!pending || event.points.length !== 1 || Math.hypot(
      event.point.x - pending.point[0], event.point.y - pending.point[1]) > DRAG_THRESHOLD_PX) {
      if (pending) this.#cancelNearbyLongPress();
    }
  }

  #cancelNearbyLongPress(): void {
    if (!this.#nearbyLongPress) return;
    window.clearTimeout(this.#nearbyLongPress.timer);
    this.#nearbyLongPress = undefined;
  }

  #setPointerCursor(event: MapMouseEvent): void {
    if (this.options.toolActive?.()) return;
    if (this.#routeDrag) {
      this.#map.getCanvas().style.cursor = 'grabbing';
      return;
    }
    const hasRouteTarget = this.options.canEditRoute() && this.#routeTarget(event.point) !== undefined;
    const hasFeature = this.#map.queryRenderedFeatures(event.point, {
      layers: this.options.interactiveLayerIds(),
    }).length > 0;
    this.#map.getCanvas().style.cursor = hasRouteTarget ? 'grab' : hasFeature ? 'pointer' : '';
  }

  #startRouteDrag(event: MapMouseEvent | MapTouchEvent): void {
    // GeoJSON hit features can lag behind comparison state while the worker updates.
    if (this.options.toolActive?.() || !this.options.canEditRoute()) return;
    if ('points' in event && event.points.length !== 1) {
      this.#finishRouteDrag(false);
      return;
    }
    if (!('points' in event) && event.originalEvent.button !== 0) return;
    const target = this.#routeTarget(event.point);
    if (target) this.#beginRouteDrag(event, target);
  }

  #routeTarget(point: MapMouseEvent['point']): RouteEditTarget | undefined {
    const layers = [ROUTE_WAYPOINT_HIT_LAYER_ID, ROUTE_LEG_HIT_LAYER_ID].filter(id => this.#map.getLayer(id));
    if (!layers.length) return undefined;
    const targets = this.#map.queryRenderedFeatures(point, { layers });
    const route = this.options.route();
    // Endpoint hit areas overlap the leg. Always move an existing waypoint there.
    const waypoint = targets.find((feature) => feature.layer.id === ROUTE_WAYPOINT_HIT_LAYER_ID);
    if (waypoint) return routeEditTarget(waypoint.properties, route);
    const leg = targets.find(feature => feature.layer.id === ROUTE_LEG_HIT_LAYER_ID);
    return leg ? routeEditTarget(leg.properties, route) : undefined;
  }

  #beginRouteDrag(
    event: MapMouseEvent | MapTouchEvent,
    identity: RouteEditTarget,
  ): void {
    if (this.#routeDrag) return;
    const route = this.options.route();
    const leg = identity.kind === 'leg' ? route.legs.find(leg => leg.edit?.afterEntryId === identity.afterEntryId) : undefined;
    const waypoint = identity.kind === 'waypoint' ? route.waypoints.find(point => point.edit?.entryId === identity.entryId) : undefined;
    event.preventDefault();
    const dragPanWasEnabled = this.#map.dragPan.isEnabled();
    const touchZoomWasEnabled = this.#map.touchZoomRotate.isEnabled();
    if (dragPanWasEnabled) this.#map.dragPan.disable();
    if (touchZoomWasEnabled) this.#map.touchZoomRotate.disable();
    this.#routeDrag = {
      target: identity,
      revision: route.revision,
      pointer: 'points' in event ? 'touch' : 'mouse',
      excludedFeatures: leg ? [leg.from.feature, leg.to.feature] : waypoint ? [waypoint.feature] : [],
      snap: undefined,
      coordinate: undefined,
      allowCoordinateDrop: identity.kind === 'leg' || waypoint?.feature.properties.kind === 'coordinate',
      dragPanWasEnabled,
      touchZoomWasEnabled,
      startPoint: [event.point.x, event.point.y],
      lastPoint: [event.point.x, event.point.y],
      distancePx: 0,
      active: false,
    };
    this.#map.getCanvas().style.cursor = 'grabbing';
  }

  #updateRouteDrag(event: MapMouseEvent | MapTouchEvent): void {
    const drag = this.#routeDrag;
    if (!drag || drag.pointer !== ('points' in event ? 'touch' : 'mouse')) return;
    if ('points' in event && event.points.length !== 1) {
      this.cancelRouteDrag();
      return;
    }
    if (!this.options.canEditRoute() || drag.revision !== this.options.route().revision) {
      this.#finishRouteDrag(false);
      return;
    }
    drag.distancePx = Math.hypot(
      event.point.x - drag.startPoint[0],
      event.point.y - drag.startPoint[1],
    );
    if (!drag.active && drag.distancePx < DRAG_THRESHOLD_PX) return;
    drag.active = true;
    this.#cancelNearbyLongPress();
    drag.lastPoint = [event.point.x, event.point.y];
    drag.snap = this.#nearestSnapFeature(event, drag);
    const candidate = drag.snap?.feature;
    drag.coordinate = !candidate && drag.allowCoordinateDrop
      ? routeCoordinateFeature([event.lngLat.lng, event.lngLat.lat]) : undefined;
    const coordinate = candidate?.geometry.coordinates ?? [event.lngLat.lng, event.lngLat.lat];
    this.options.preview({ route: this.options.route(), preview: {
      target: drag.target, revision: drag.revision, coordinate, snapped: candidate !== undefined,
    } });
  }

  #endRouteDrag(event: MapMouseEvent | MapTouchEvent): void {
    const drag = this.#routeDrag;
    if (!drag || drag.pointer !== ('points' in event ? 'touch' : 'mouse')) return;
    if (!('points' in event) && event.originalEvent.button !== 0) return;
    const canvas = this.#map.getCanvas();
    // Touch events stay targeted at the canvas even when the finger leaves it.
    if ('points' in event && (event.originalEvent.touches.length !== 0 || event.points.length !== 1) ||
      event.point.x < 0 || event.point.y < 0 || event.point.x > canvas.clientWidth || event.point.y > canvas.clientHeight) {
      this.cancelRouteDrag();
      return;
    }
    // Preserve the preview at an unchanged pointer position: a source/label
    // refresh must not choose a new drop target only on release. A release can
    // update an active drag's final position, but cannot start an unseen edit.
    if (drag.active && (event.point.x !== drag.lastPoint[0] || event.point.y !== drag.lastPoint[1])) {
      this.#updateRouteDrag(event);
    }
    this.#finishRouteDrag();
  }

  #finishRouteDrag(commit = true): void {
    const drag = this.#routeDrag;
    if (!drag) return;
    commit = commit && this.options.canEditRoute() && drag.revision === this.options.route().revision;
    this.#routeDrag = undefined;
    if (drag.dragPanWasEnabled) this.#map.dragPan.enable();
    if (drag.touchZoomWasEnabled) this.#map.touchZoomRotate.enable();
    this.#map.getCanvas().style.cursor = '';
    this.options.preview({ route: this.options.route() });
    // Tile properties suffice for the drag preview. Restore the full reference
    // only for a committed drop, never once per candidate on every move event.
    const candidate = drag.snap?.feature;
    const dropFeature = commit && drag.active && candidate
      ? this.options.resolveFeature?.(candidate) ?? candidate : drag.coordinate;
    if (commit && drag.active && drag.target.kind === 'leg' && dropFeature) {
      this.options.onRouteLegInsert(drag.target.afterEntryId, dropFeature);
    }
    if (commit && drag.active && drag.target.kind === 'waypoint') {
      if (dropFeature) {
        this.options.onRouteWaypointReplace(drag.target.entryId, dropFeature);
      } else if (drag.distancePx >= REMOVE_DISTANCE_PX) {
        this.options.onRouteWaypointRemove(drag.target.entryId);
      }
    }
    if (drag.active) this.#suppressNextClick();
  }

  #nearestSnapFeature(event: MapMouseEvent | MapTouchEvent, drag: RouteDragState): RouteSnap | undefined {
    const { x, y } = event.point;
    const layers = this.options.interactiveLayerIds();
    const features = this.#map.queryRenderedFeatures(
      [[x - ROUTE_SNAP_RADIUS_PX, y - ROUTE_SNAP_RADIUS_PX], [x + ROUTE_SNAP_RADIUS_PX, y + ROUTE_SNAP_RADIUS_PX]],
      { layers },
    ).filter(isPointFeature);
    const candidates = features
      // A GPS marker has no feature ID, and its preview has already moved away
      // from the original coordinate. Exclude it by entry identity before stripping
      // editing properties, so it cannot snap to its own marker or label.
      .filter(feature => !(drag.target.kind === 'waypoint' && feature.source === ROUTE_SOURCE_ID &&
        feature.properties.editEntryId === drag.target.entryId))
      .map(toPointFeature)
      .filter(feature => !drag.excludedFeatures.some(excluded => sameFeature(feature, excluded)));
    const coordinate = (feature: GeoPointFeature) =>
      unwrapRouteCoordinates([feature.geometry.coordinates], event.lngLat.lng)[0]!;
    const project = (feature: GeoPointFeature) => this.#map.project(coordinate(feature));
    return routeSnapFeature(candidates, drag.snap, feature => {
      const anchor = project(feature);
      return [x - anchor.x, y - anchor.y];
    }, feature => {
      const matches = (candidate: MapGeoJSONFeature) => isPointFeature(candidate) && sameFeature(feature, toPointFeature(candidate));
      const sources = new Set(features.filter(matches).map(candidate => candidate.source));
      // Include the target's other icon/label layers, without scanning unrelated
      // navigation sources while measuring its captured hit area.
      const targetLayers = layers.filter(id => {
        const source = this.#map.getLayer(id)?.source;
        return source !== undefined && sources.has(source);
      });
      return renderedSnapBounds(this.#map, feature, targetLayers, coordinate(feature), matches);
    });
  }

  #featureDistance(feature: GeoPointFeature, point: MapMouseEvent['point'], longitude: number): number {
    // Query geometry uses canonical longitudes; compare in the world copy under the pointer.
    const coordinate = unwrapRouteCoordinates([feature.geometry.coordinates], longitude)[0]!;
    const projected = this.#map.project(coordinate);
    return Math.hypot(projected.x - point.x, projected.y - point.y);
  }

  #resolveFeature(feature: MapPointFeature): GeoPointFeature {
    const point = toPointFeature(feature);
    return this.options.resolveFeature?.(point) ?? point;
  }

  #suppressNextClick(): void {
    this.#suppressClick = true;
    if (this.#suppressClickTimer !== undefined) {
      window.clearTimeout(this.#suppressClickTimer);
    }
    this.#suppressClickTimer = window.setTimeout(() => {
      this.#suppressClick = false;
      this.#suppressClickTimer = undefined;
    }, 400);
  }

  #clearClickSuppression(): void {
    this.#suppressClick = false;
    if (this.#suppressClickTimer !== undefined) window.clearTimeout(this.#suppressClickTimer);
    this.#suppressClickTimer = undefined;
  }

  #finishDragOutsideMap = (event: Event): void => {
    if (event.type === 'mouseup' && (this.#routeDrag?.pointer !== 'mouse' || (event as MouseEvent).button !== 0)) return;
    if (event.type !== 'mouseup' && this.#routeDrag?.pointer === 'mouse') return;
    // An in-map release already committed with its actual position. A release
    // reaching only the window must never commit the last in-map preview.
    this.#cancelGesture();
  };

  #cancelGesture = (): void => { this.cancelRouteDrag(); this.#cancelNearbyLongPress(); };
  #cancelOnEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && (this.#routeDrag || this.#nearbyLongPress)) {
      event.preventDefault();
      this.#cancelGesture();
    }
  };
}

type MapPointFeature = MapGeoJSONFeature & { geometry: GeoPointFeature['geometry'] };

function isPointFeature(feature: MapGeoJSONFeature): feature is MapPointFeature {
  return feature.geometry.type === 'Point';
}

function toPointFeature(feature: MapPointFeature): GeoPointFeature {
  // Route markers also carry navigation data. Do not persist their transient
  // editing state when a selected/snapped point is reused in another route.
  const properties = { ...feature.properties };
  // Tile encoding can turn a string GeoJSON ID into 0. Recover the original
  // identity so named points still match their navigation data and route entries.
  const id = typeof properties.mapFeatureId === 'string' ? properties.mapFeatureId
    : typeof feature.id === 'string' ? feature.id : undefined;
  delete properties.mapFeatureId;
  if (feature.source === ROUTE_SOURCE_ID) {
    for (const key of ['routeKind', 'routePointId', 'navigationLayer', 'editKind', 'editEntryId', 'planRevision', 'dragging', 'snapped',
      'displayIdent', 'approachRole', 'holdLabelOnRight', 'approachPoint']) {
      delete properties[key];
    }
  }
  return restoreRouteCoordinate({
    type: 'Feature',
    ...(id === undefined ? {} : { id }),
    geometry: {
      type: 'Point',
      coordinates: feature.geometry.coordinates as [number, number],
    },
    // Tile queries return null-prototype properties that MapLibre's worker
    // serializer cannot accept when selection or route snapping reuses them.
    properties,
  });
}
