# Captured NOAA METAR regression fixture

Captured September 23, 2026 from NOAA surface observations, layer 60. These are
dated source samples, not current weather. Current clients read AWC through the
info server. [METAR view tests](../../metar-view.test.ts) use the captured raw
reports to check pressure and sky conditions through the shared parser.

- `metars-noaa.json`: seven stations from NOAA surface observations, layer 60:
  KSFO, KSBA, KLAX, PAFA, PHNL, EGLL and CYVR. Includes raw text, epoch-millisecond
  observation time, original geometry, station identity and the METAR network tag.

Source:
`https://mapservices.weather.noaa.gov/vector/rest/services/obs/surface_obs/MapServer/60/query`,
using GeoJSON, `outSR=4326`, the listed station IDs and `tblname = 'METAR'`.

The retired NWS observation/TAF experiment's captures are separate from these
fixtures; the [METAR/TAF guide](../../../src/layers/metar-taf/README.md#contracts-and-verification)
records their location, source times and comparison purpose.
