# Direct NOAA/NWS report fixtures

Captured September 23, 2026 from public NOAA/NWS services. These are dated source
samples retained from the retired direct METAR/TAF experiment, not current weather.
Current clients read AWC through the weather gateway; these fixtures retain the
source-comparison evidence.
The [source choices](../../../docs/data/sources.md#source-choices-and-unresolved-alternatives)
explain the freshness, bulletin and coverage limits. These historical samples are
not used by the current tests or runtime.

- `metar-ksfo.json`: NWS KSFO observation at 17:56 UTC, preserving both raw aviation
  groups and the rounded decoded metric fields that exposed the precision issue.
- `taf-ksfo.xml` / `.json`: KSFO IWXXM and matching coded bulletin, issued 17:27 UTC.
- `taf-ksfo-amended.xml` / `.json`: actual KSFO 20:33 UTC amendment; the XML bulletin
  identifier includes the WMO `AAA` suffix.
- `taf-pafa.xml` / `.json`: PAFA IWXXM and matching 17:20 UTC coded bulletin,
  exercising issuing-office lookup for the PAFA/FAI identifier difference.
- `metars-noaa.json`: seven stations from NOAA surface observations, layer 60:
  KSFO, KSBA, KLAX, PAFA, PHNL, EGLL and CYVR. Includes raw text, epoch-millisecond
  observation time, original geometry, station identity and the METAR network tag.

NWS source entry points:
`https://api.weather.gov/stations/KSFO/observations`, station `tafs` lists and their
IWXXM resource URLs, `products/types/TAF/locations/SFO/latest`, and the `products`
query with the IWXXM issuing office and exact issue minute. Bulk source:
`https://mapservices.weather.noaa.gov/vector/rest/services/obs/surface_obs/MapServer/60/query`,
using GeoJSON, `outSR=4326`, the listed station IDs and `tblname = 'METAR'`.
