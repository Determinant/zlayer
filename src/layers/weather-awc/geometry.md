# Weather geometry

[AWC Weather](README.md) / Geometry preparation

Geometry preparation preserves source meaning before publication. It must keep
raw evidence, reject ambiguous or unsupported input explicitly, and distinguish
source validation from failures in our transformations. This guide records the
shared conventions and executable acceptance criteria; it does not qualify a
new NOAA product or promise that finite tests establish every possible case.

## Coordinate conventions

`geographic.ts` owns geographic longitude wrapping, nearest-world selection and
date-line intersections for advisory paths and Progs curves. Its named tuple is
`[longitude, latitude]` in degrees. Canonical points use `[-180, 180)` longitude;
split boundaries can also use `+180` to keep each part on its own side. Unwrapped
paths retain their continuous world copy until preparation is complete. Native
radar cells and Lambert metres remain in their product-specific coordinate spaces.

Adapters validate finite coordinates and their source-specific ranges **before**
wrapping. Remainder-based wrapping preserves the representable values immediately
beside ±180°; adding 180 before taking a floor can round a valid longitude beyond
the opposite bound. Nearest-world selection chooses the eastern copy at an exact
180° tie, retaining AWC's curve convention. Advisory edges of exactly 180° remain
ambiguous and are rejected.

Seam intersections interpolate in geographic degrees, preserve exact source
endpoints and supply the same latitude on both seam copies. Polygon fill clipping
and source outlines stay separate: an artificial fill seam is never a reported
weather boundary. Each adapter owns its line budgets and duplicate-point policy.

## Fidelity and limits

| Product | Required invariant | Accuracy boundary |
| --- | --- | --- |
| Advisories | Same covered region, holes and original outline; no silent topology repair | Planar GeoJSON edges in unwrapped degrees; no inferred geodesic arcs or coordinate snapping |
| Progs | Every control point and line direction survives; finite, bounded output and bounded line parts | AWC's 16-subdivision cardinal presentation, added vertices rounded to five decimals; only pole-overshooting segments use straight subdivisions |
| MRMS radar | Every island and hole survives simplification; edges cannot cross or sweep over another contour | At most 0.1 native cell displacement; contour interpolation adds no new observation |
| TDWR and storm motion | Source bearings, range gates, gaps and native forecast positions survive projection | The qualified spherical projection and source precision documented in the radar guide |
| Forecast grids | Same nearest source cell and true wind-vector orientation | Qualified spherical Lambert projection, native-cell resolution, and documented value rounding; resampling does not add model resolution |

Advisory topology validation compares the complete cyclic sequence of boundary
turns before and after canonicalization. Winding, starting vertex, adjacent
duplicates and forward-collinear vertices do not change that boundary. A reversed
edge, changed corner or lost hole cannot be excused by a small perimeter change.
Geometry that a clipping library cannot preserve at its numerical precision stays
an explicit source issue. Source evidence remains available for diagnosis.
The combined exterior and holes must also preserve those boundaries under union,
even when no date-line split is needed. A hole duplicating the exterior or sharing
an edge cannot publish an empty or silently repaired hazard area.

Grid sampling and wind rotation share one Lambert setup. Longitude differences
are wrapped around the central meridian for both the first source cell and target
samples; a date-line crossing cannot itself imply missing coverage. GRIB2 source
longitudes are checked in the encoded 0–360° domain before normalization, following
[regulation 92.1.8](https://codes.ecmwf.int/grib/format/grib2/regulations/).
Missing/reserved or out-of-range longitude metadata cannot become valid through
modulo. Supported projection/scanning profiles retain their other existing bounds.

## Regression obligations

- [`weather-geometry.test.ts`](../../../test/weather-geometry.test.ts) checks
  representable seam neighbors, canonical bounds, world-copy equivalence,
  reversal, seam length conservation, complete curve controls and source
  immutability. Seeded concave polygons vary shape, size, winding and starting
  vertex; tiny holes must remain empty, interior coverage must remain filled,
  and area/outline length must survive splitting and repeated preparation.
  Thin valid polygons remain accepted while short retraced edges are rejected.
- [`weather-projection.test.ts`](../../../test/weather-projection.test.ts) uses
  independent Proj4 transforms for source-cell selection across tangent/secant
  Lambert grids and the date line. Inverse-projection directions independently
  check wind rotation and speed conservation within output rounding.
- [`weather-radar-contours.test.ts`](../../../test/weather-radar-contours.test.ts)
  retains the independent D3 comparisons and generates continuous fields across
  all published thresholds. Simplification must preserve closure, orientation,
  island/hole counts, hole containment and the displacement bound without mutating
  native contours.
- Captured advisory/Progs fixtures and GDAL grid/wind references remain separate
  regression oracles. Synthetic invariants complement these references; they do
  not replace them or justify relaxing the source and wire bounds.

Use fixed seeds and retain a minimal failing case when generated checks expose a
defect. Area oracles translate coordinates before taking cross products so tiny
shapes at large longitudes do not disappear through cancellation in the test.
New coordinate-space or interpolation policies require their own error bounds,
source qualification and cache-identity review. Browser rendering and physical
device qualification remain separate from these server preparation checks.
