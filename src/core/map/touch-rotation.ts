import type { TwoFingersTouchZoomRotateHandler } from 'maplibre-gl';

const ROTATION_START_DEGREES = 20;

/** Require a deliberate twist before a pinch can rotate the map. */
export function configureTouchRotation(
  gestures: Pick<TwoFingersTouchZoomRotateHandler, '_touchRotate'>,
): void {
  // MapLibre 6.9 has no public rotation-threshold setter. Keep this adaptation
  // local and exercise the real handler in tests when upgrading the pinned version.
  const rotate = gestures._touchRotate;
  const move = rotate._move;
  rotate._move = function (points, pinchAround, event) {
    if (!this.isActive()) {
      const vector = points[0].sub(points[1]);
      // Always evaluate the native guard: it remembers the minimum finger spacing
      // and requires a larger angle when fingers are close together.
      const belowNativeThreshold = this._isBelowThreshold(vector);
      const degrees = this._startVector
        ? Math.abs(vector.angleWith(this._startVector) * 180 / Math.PI)
        : 0;
      this._vector = vector;
      if (belowNativeThreshold || degrees < ROTATION_START_DEGREES) return;

      // Discard the activation movement, so crossing the dead zone cannot jump
      // the bearing. Native touch end/cancel/disable resets this latch.
      this._active = true;
      return;
    }
    return move.call(this, points, pinchAround, event);
  };
}
