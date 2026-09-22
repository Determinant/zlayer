# Map ruler

[Documentation](../../../docs/README.md) / Plugins / ruler

The ruler button sits directly below Layers. It starts a temporary measurement;
closing it clears the measurement and restores ordinary map selection and route
editing. It does not restore an active input mode after reloading.

- Mouse or trackpad: click A, then click B.
- Touch: tap A. B appears about 120 CSS pixels above A, or toward available space
  near an edge. Drag B's labeled grip to establish the endpoint.
- Drag either labeled grip to adjust. Its leader points to an open crosshair at
  the exact geographic endpoint; the grip remains offset from the finger.
- Pan, pinch and wheel zoom retain the geographic endpoints. Map taps after
  placement do not dismiss or replace them.
- Reverse swaps the endpoints and recalculates the initial bearing at the new
  start. New starts another measurement. Close clears and exits.
- Focus a grip and use arrow keys to move one screen pixel, or Shift+arrow for
  ten pixels. Escape cancels an active drag; otherwise it closes the ruler.
  Focused menus, NavLog and route-editor gestures handle Escape before ruler dismissal.

The edge card shows great-circle nautical miles and initial A-to-B magnetic
bearing, with true bearing directly beneath it. The rendered line follows the
same great circle, including across the antimeridian, and shares the ID overlay's
dark-blue dashes and white casing. The WMM2025 evaluator is shared with AHRS in
`src/core/geo/magnetic-model.ts`. The catalog loader supplies validated, cached
coefficients; the ruler needs no GPS or motion permission. It evaluates at A,
zero ellipsoid height and the current date. Missing/expired coefficients or weak
polar fields leave magnetic bearing empty while true bearing remains available.
Coincident, antipodal, or geographic-pole starts do not produce an arbitrary bearing.

`src/layers/ruler/` owns state, measurement, renderer, pointer interaction, grips,
and the card. Workspace composition supplies the product and feed revision; the
shell places the control. The shared gesture coordinator gates feature selection,
route editing and context actions while the ruler is active. Only grip buttons
claim their drag; canvas listeners observe taps and leave native map navigation
available. A second contact, cancellation, lost capture, window blur, or an
outside release cancels the preview. Cleanup restores double-click zoom.

`test/ruler.test.ts` checks geometry, magnetic reference, state transitions and
grip placement. `test/e2e/ruler.spec.ts` exercises real map mouse/touch input,
gesture ownership, cancellation, keyboard adjustment, fallback labels, rotation,
and the control layout at phone and iPad mini sizes. Physical iPad mini Safari
validation remains necessary to assess finger/hand occlusion and comfort.
