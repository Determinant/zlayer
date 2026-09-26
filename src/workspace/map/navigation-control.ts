import { NavigationControl, type Map as MapLibreMap } from 'maplibre-gl';
import { isBoolean, readUiState, writeUiState } from '../../core/storage/ui-state';
import type { LayerStore } from '../../core/layers/store';
import { GPS_MOTION_ACCURACY_METERS, type GpsFix } from '../../core/gps/position';
type OrientationFix = Pick<GpsFix, 'coordinates' | 'accuracy' | 'track'>;
export type OrientationSource = LayerStore<{ enabled: boolean; state: string; fix?: OrientationFix | null | undefined }>;

/** Zoom and an aviation orientation toggle sharing the existing GPS watch. */
export class MapNavigationControl extends NavigationControl {
  readonly #ownship: OrientationSource;
  readonly #toggle = document.createElement('button');
  readonly #mode = document.createElement('span');
  #map: MapLibreMap | undefined;
  #unsubscribe: (() => void) | undefined;
  #trackUp = readUiState('map-track-up', false, isBoolean);
  #lastFix: OrientationFix | null | undefined;
  #pendingCenter = false;
  #following = false;

  constructor(ownship: OrientationSource) {
    super({ showCompass: false });
    this.#ownship = ownship;
    this.#toggle.type = 'button';
    this.#toggle.className = 'map-orientation-toggle';
    this.#toggle.setAttribute('aria-label', 'Track up');
    this.#mode.className = 'map-orientation-mode';
    const up = document.createElement('span');
    up.className = 'map-orientation-up';
    up.textContent = 'UP';
    this.#toggle.append(this.#mode, up);
    this.#toggle.addEventListener('click', () => {
      this.#trackUp = !this.#trackUp;
      writeUiState('map-track-up', this.#trackUp);
      this.#pendingCenter = this.#trackUp;
      this.#update();
    });
  }

  override onAdd(map: MapLibreMap): HTMLElement {
    const container = super.onAdd(map);
    container.classList.add('map-navigation-control');
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Map navigation');
    container.append(this.#toggle);
    this.#map = map;
    this.#unsubscribe = this.#ownship.subscribe(this.#onGps);
    map.on('moveend', this.#onMoveEnd);
    this.#onGps();
    return container;
  }

  override onRemove(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#map?.off('moveend', this.#onMoveEnd);
    if (this.#following) this.#map?.stop();
    this.#map = undefined;
    this.#following = this.#pendingCenter = false;
    this.#lastFix = undefined;
    super.onRemove();
  }

  /** Fit cameras at the intended orientation, including during a rotation. */
  getTargetBearing(): number {
    return this.#desiredBearing ?? this.#map?.getBearing() ?? 0;
  }

  get #desiredBearing(): number | null {
    if (!this.#trackUp) return 0;
    return this.#usableFix?.track ?? null;
  }

  get #usableFix(): OrientationFix | null {
    const snapshot = this.#ownship.getSnapshot();
    return snapshot.enabled && snapshot.state === 'tracking' && snapshot.fix
      && snapshot.fix.accuracy <= GPS_MOTION_ACCURACY_METERS ? snapshot.fix : null;
  }

  readonly #onGps = (): void => {
    const fix = this.#ownship.getSnapshot().fix;
    if (this.#trackUp && fix !== this.#lastFix) this.#pendingCenter = true;
    this.#lastFix = fix;
    this.#update();
  };

  readonly #onMoveEnd = (): void => {
    this.#following = false;
    this.#update();
  };

  readonly #update = (): void => {
    const map = this.#map;
    if (!map) return;
    const bearing = this.#desiredBearing;
    const waiting = bearing === null;
    const description = this.#trackUp
      ? `Track up${waiting ? ' · Waiting for GPS track' : ''} · Switch to north up`
      : 'North up · Switch to track up';
    this.#mode.textContent = this.#trackUp ? 'TRK' : 'N';
    this.#toggle.setAttribute('aria-pressed', String(this.#trackUp));
    this.#toggle.setAttribute('aria-description', description);
    this.#toggle.title = description;
    this.#toggle.classList.toggle('is-waiting', waiting);

    const fix = this.#trackUp ? this.#usableFix : null;
    if (!fix) {
      this.#pendingCenter = false;
      // Stop only our GPS animation; lost GPS must not cancel a user's pan/fit.
      if (this.#following) { this.#following = false; map.stop(); }
    }
    // Defer fresh fixes until a pan, zoom, or route fit finishes. Once applied,
    // that fix must not undo a later camera command on its moveend event.
    if (map.isMoving()) return;
    let center: [number, number] | undefined;
    if (fix && this.#pendingCenter) {
      this.#pendingCenter = false;
      const current = map.getCenter();
      const [lng, lat] = fix.coordinates;
      const longitude = lng + 360 * Math.round((current.lng - lng) / 360);
      if (Math.abs(longitude - current.lng) > 1e-9 || Math.abs(lat - current.lat) > 1e-9) center = [longitude, lat];
    }
    const difference = bearing === null ? 0 : ((bearing - map.getBearing() + 540) % 360) - 180;
    if (center || Math.abs(difference) > 0.01) {
      this.#following = this.#trackUp;
      map.easeTo({ ...(center && { center }), ...(bearing !== null && { bearing }), duration: 250 });
    }
  };
}
