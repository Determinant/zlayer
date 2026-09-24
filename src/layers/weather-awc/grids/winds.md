# Winds and temperatures aloft

[AWC Weather](../README.md) / [Forecast grids](README.md)

The **Winds** content tab offers independent **Show winds** and **Show temperature**
on/off switches using core's shared switch indicator. **Show winds** controls wind
barbs, which coexist with cloud/icing shading and advisory outlines.
**Show temperature** enables temperature shading in place of the single shaded
field, while retaining barbs and advisories. Turning it off clears temperature
shading; it does not restore an earlier cloud/icing field. Choosing another shaded
field turns this switch off without changing **Show winds**.
Switching toolbox tabs never changes those visibility choices. The six weather
tabs use two rows of core slim controls and share one horizontally scrollable timeline.

Winds share the toolbox and timeline so pilots can compose them with cloud/icing
and advisories. One wind stream supplies barbs and temperature. Icing retains its
own altitude because its native coordinate differs. MSL uses forecast heights;
standard-atmosphere pressure height must not be relabeled as MSL. This is CONUS
HRRR model guidance, not sparse FB station forecasts. Extended runs, full profiles,
and Alaska/global coverage remain future work. [Surface analysis and Progs](../progs/README.md)
are a separate implemented overlay on the same timeline.

## Source and levels

NOAA HRRR CONUS `wrfprsfNN.grib2` provides hourly frames F000–F018, from an hourly
model run on its native 3 km grid. Discovery checks all offered fields/levels in
each index before accepting a run. The source pressure levels are 1000–100 hPa,
in 25 hPa steps. The **Wind altitude** slider selects 500–17,500 ft MSL in 500-ft
steps, then FL180–FL530 in 1,000-ft pressure-altitude steps. Its readout, tick labels
and accessible values distinguish MSL from flight levels. The default is
**5,000 ft MSL**; barbs initially remain off. Wind altitude stays independent of
icing altitude. The `awcWindAltitude` preference replaces `awcWindPressure`;
an older saved pressure migrates to the nearest offered altitude using its
standard-atmosphere height. This migration changes the sampled surface below
18,000 ft to MSL, rather than retaining the old pressure slice under a new label.

The PWA derives selected slices from those pressure-level sources:

- Below 18,000 ft, each cell's forecast HGT values locate its bracketing levels.
  Linearly interpolate earth-relative U/V and temperature in forecast height.
- From FL180, convert the selected flight level to standard-atmosphere pressure,
  then linearly interpolate HGT, U/V and temperature in log pressure. The resulting
  forecast MSL height varies over the map and appears in point inspection.
- Compute wind speed and direction **after** interpolating components; never
  interpolate direction angles. Exact source heights retain their own samples.
  Missing components remain unavailable independently of temperature. Missing,
  inverted or unbracketed heights do not extrapolate or skip over a missing bracket.

For MSL, the upper-level weight is `(selectedHeight − lowerHeight) / (upperHeight − lowerHeight)`.
For flight levels it is `ln(lowerPressure / selectedPressure) / ln(lowerPressure / upperPressure)`;
lower altitude has higher pressure. Only weights within the bracket are used.
Apply the weight to each U/V/temperature band; MSL output height is the selected
height, while flight-level output height uses the same log-pressure weight.
An exact-height sample is accepted before comparing the other height: a missing
neighbor must not discard it when another cell has expanded the search.

Here MSL uses the model's **geopotential height** convention, also used by the
existing cloud/freezing fields, rather than GPS ellipsoid height or AGL. Standard
atmosphere is used only for flight levels and for choosing the initial MSL search
level. It uses 1013.25 hPa at zero height, a lapse-rate layer through 11 km and an
isothermal layer through 20 km, covering the entire selector. See NASA's
[standard-atmosphere equations and layers](https://ntrs.nasa.gov/api/citations/20050207438/downloads/20050207438.pdf),
UCAR's [linear vertical interpolation](https://www.ncl.ucar.edu/Document/Functions/Built-in/wrf_interp_1d.shtml)
and [height-MSL/log-pressure coordinates](https://www.ncl.ucar.edu/Document/Functions/WRF_arw/wrf_user_vert_interp.shtml).
These references support the numerical choices; they are not device validation.

`wind-levels.ts` owns selection and migration; `wind-interpolation.ts` owns numeric
sampling. Source catalogs remain pressure-coordinate metadata. Selected descriptors
carry their separate MSL/flight-level identity and eligible source levels. A full
vertical profile, Alaska/global coverage and extended 48-hour runs are not implemented.
The [source inventory](https://www.nco.ncep.noaa.gov/pmb/products/hrrr/hrrr.t00z.wrfprsf02.grib2.shtml)
and [HRRR description](https://emc.ncep.noaa.gov/emc/pages/numerical_forecast_systems/hrrr.php)
describe these source products.

Each converted source-level bundle contains, in order:

| Field | Source | Converted meaning |
| --- | --- | --- |
| `windHeight` | HGT, category 3 / parameter 5 / surface 100 | Geopotential height, rounded to 10 ft MSL |
| `windEast` | UGRD, category 2 / parameter 2 / surface 100 | True eastward component, rounded to 0.1 kt |
| `windNorth` | VGRD, category 2 / parameter 3 / surface 100 | True northward component, rounded to 0.1 kt |
| `temperature` | TMP, category 0 / parameter 0 / surface 100 | Temperature, rounded to 0.1°C |

GRIB validation checks the pressure value in Pa, in addition to run, lead,
parameter, surface, geometry and supported packing. Height is converted first.
The shared same-run HRRR F000 terrain artifact masks samples at/below terrain;
missing height/terrain remains unavailable. Each source bitmap remains respected.
Pressure-level values extrapolated below terrain cannot produce barbs or shading.
Native MSL slices also explicitly mask selected heights at/below model terrain.
Archived sources retain their published masks: without terrain or an above-ground
bracket, they cannot invent a near-surface sample. Outside coverage remains distinct
from missing terrain. Interpolation follows source quantization and retains its
Float32 result; the display does not imply precision beyond the source bands.

For grid-relative U/V, rotate at the actual nearest **native source cell** before
rounding the east/north components. WMO component flag 5 distinguishes earth-relative
and grid-relative vectors; mismatched component orientation is rejected. In spherical
Lambert coordinates the convergence angle is `n × (longitude − central meridian)`:
`east = u cos(angle) + v sin(angle)`, `north = −u sin(angle) + v cos(angle)`.
Derived wind direction is meteorological **from**, degrees true, with speed in knots.
References: [grid template 3.30](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_temp3-30.shtml),
[component flags](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_table3-3.shtml).

## Display density and rendering

Wind and temperature values share the point-weather card with enabled cloud or
icing values. A matching provider, HRRR run and valid time share their metadata;
different runs, times or the IFI model retain separate labeled subsections.
The wind altitude and each product's freshness remain explicit.

Point inspection displays magnetic direction first, then true with a slash:
`297°M / 310°T · 3.9 kt`. It reuses AHRS/ruler's shared WMM2025 evaluator and
the browsing cycle's validated, offline-capable magnetic-model loader. Variation
uses the inspected location and forecast valid time, with zero ellipsoid height
as in the ruler; forecast geopotential MSL height is not ellipsoid altitude.
Evaluation is memoized by model, location and forecast time. Loading is limited
to an open wind inspection and retries on reopening/reconnection. Missing/expired
models, weak horizontal fields and geographic poles leave magnetic as `—`, keep
true available, and show that variation is unavailable. Calm has no direction.
Map barbs retain their true geographic orientation.

`wind.ts` selects a nested Web Mercator lattice anchored to the world. Normal
spacing is 80–160 CSS pixels, independent of screen pixel density; the lattice
stops subdividing at the converted forecast's resolution. Pan preserves geographic
anchors, and zoom subdivisions retain the previous coarser anchors. Only the
viewport plus a 64-pixel margin is considered. Candidate iteration and final
symbol count are bounded by viewport area. A screen-space spatial hash enforces
64-pixel minimum anchor separation under rotation/pitch, and a model cell cannot
produce duplicate symbols. At very high zoom there may be fewer symbols because
the forecast does not supply finer spatial detail.
Viewport clipping and screen projection use the visible world copy, while numeric
sampling keeps canonical model longitudes, including views across the wrap boundary.

The converted grid uses the existing 4096-metre **projected** spacing, whose ground
spacing varies by latitude; it is not a claim of extra resolution beyond HRRR.
Numeric point inspection retains the full converted field regardless of symbol
density. Rendering never changes time availability or thins the forecast sequence.

`wind-map.ts` batches the selected points into one MapLibre GeoJSON/symbol layer.
Small reusable images draw a 26-pixel shaft with 1.5-pixel dark strokes and a
restrained white halo. Conventional half/full barbs and flags represent 5/10/50 kt,
rounded to the nearest 5 kt; a circle represents less than 2.5 kt. Numeric details
retain the component precision. Feathers lean toward the shaft's source end on
the Northern Hemisphere side, and 50-kt pennants use a right triangle, following
the [NWS wind-barb examples](https://www.weather.gov/hfo/windbarbinfo).
Icons rotate with the map from their true
meteorological direction. No per-point DOM, continuously animated canvas, or full
CONUS symbol collection is created.

MapLibre transforms existing symbols during camera movement. Placement updates
at lattice zoom thresholds, move completion and resize; weather status and opacity
updates do not rebuild the wind source. Camera updates reuse numeric data and
never acquire or decode forecasts. Wind resources, images and subscriptions are
removed on disable/unmount and recreated through the normal map lifecycle.

## Time, preparation and cache

The [grid controller contract](README.md#time-recovery-and-budgets) governs selected
loads, catalog replacement, saving, retries, cancellation and freshness. Winds have
an independent controller so a failed or slow wind request does not block scalar
weather. Barbs and temperature share its selected bundle and saved-file counts.
Barbs alone warm neighbors; temperature extends the same stream to the remaining
selected-altitude horizon without resetting completion. Turning temperature off
cancels distant work while enabled barbs retain neighbors. Both off stops wind demand.

Wind times contribute timeline stops only while barbs or temperature are enabled.
A changed time/run/altitude immediately hides obsolete symbols and temperature.
Only matching validated data can return after MapLibre accepts the update; source
errors invalidate pending commits. Failed renderers use **Retry forecasts**.
Camera changes reuse the same numeric forecast, acquiring no source data.

The server prepares the original 37 pressure levels once for all viewers. The
PWA downloads required brackets plus same-run terrain using core's `pressure-levels`
and `model-terrain` caches, interpolates in its worker, and saves the result through
core's `converted-grids` cache. Revisiting a retained selected slice needs no new
interpolation; nearby altitudes can reuse native inputs. The PWA does not download
the complete vertical matrix during startup.

Flight levels require the two bracketing pressures, or one exact match. MSL starts
near standard-atmosphere pressure, expanding only where unresolved cells' actual
forecast heights require more levels. Only two expanding boundary levels remain
decoded. Completed brackets stay fixed as the search expands elsewhere. There is
no vertical cube or plugin-owned persistent cache/transfer scheduler.

Derived identity includes selected altitude/datum, `wind-vertical-v2`, all eligible
source identities, run, validity and geometry. At most 32 complete wind keys are
memoized per immutable catalog. Flight-level log weights are computed once per
bracket; MSL weights are cell-specific. Neither path computes logarithms per cell.
Archived-feed overrides retain their checksum-validated pressure inputs and masks.

One admitted wind job owns its worker throughout interpolation and disposes it on
completion, cancellation or failure. Each numeric operation borrows core's shared
CPU slot; network/storage waits leave scalar acquisition and decoding available.
At the current output size, two boundary levels, an output and a temporary incoming
level can overlap at about 101.6 MiB, plus terrain, compact/compressed input and
worker scratch. Completed slices retain compact bands when exactly representable,
otherwise Float32. This is an allocation bound, not a measured device peak.
The shared AWC file/neighborhood limits in the grid guide include all wind inputs,
outputs and terrain; retained files remain subject to eviction.

## Verification

[Wind reference data](../../../../test/fixtures/awc-grib/wind-reference.json)
records four captured 850 hPa fields with independent GDAL Float32 hashes and
rotation references. `test/weather-winds.test.ts` covers source metadata, MSL and
log-pressure interpolation, exact-height/missing-bracket handling, terrain masks,
identity, migration, direction and bounded barb placement. These representative
records do not qualify every operational cycle or device.

Browser cases in `test/e2e/weather-winds.spec.ts` and `weather-native.spec.ts` cover
combined displays, pressure-input reuse, selected-altitude offline reopening,
shared progress and camera movement without forecast acquisition. The existence
of these cases is not a passing result. Physical-device memory, readability over
VFR/IFR charts, touch/keyboard behavior and WebGL recovery remain release checks.
