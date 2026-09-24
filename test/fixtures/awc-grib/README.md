# Qualified NOAA GRIB2 samples

These are individual GRIB2 messages from NOAA NOMADS, cycle 2026-09-22 21Z,
one-hour forecast. The number in each filename is its one-based source index
record. HRRR records come from
`hrrr/prod/hrrr.20260922/conus/hrrr.t21z.wrfsfcf01.grib2`; IFI records come from
`dafs/prod/dafs.20260922/dafs.t21z.ifi.3km.conus.f001.grib2`, at 8,000 ft MSL.
Both paths are relative to `https://nomads.ncep.noaa.gov/pub/data/nccf/com/`.
NOAA's rolling source files may no longer be available for this dated cycle.

`reference.json` records source SHA-256 and independently computed output SHA-256
for every projected, quantized cell. These retained oracle outputs were generated
independently with rasterio/GDAL and a Python reference converter, before that
duplicate tooling was removed. They remain independent of the production TypeScript
decoder and projection. Unit tests check the retained source hashes
and all 1,664,632 output cells per field. The elapsed times in the reference are
dated host measurements, not mobile-browser performance guarantees.

The larger [qualification record](../../../src/layers/weather-awc/validation/2026-09-23-browser-grib.json)
also includes cloud top and the lowest freezing diagnostic. These are fixtures
for validation only; production retrieves selected source ranges and prepares
numeric slices in the TypeScript weather server worker.
