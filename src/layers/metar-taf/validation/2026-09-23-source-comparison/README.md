# Historical NOAA/NWS source comparison

[METAR/TAF](../../README.md) / Validation

Captured September 23, 2026 from public NOAA/NWS services during the retired
direct METAR/TAF experiment. These original source bytes preserve the comparison
evidence; no current test or runtime consumes them. Current clients read AWC
through the info server. The [source choices](../../../../../docs/data/sources.md#source-choices-and-unresolved-alternatives)
explain the freshness, bulletin and coverage limits.

- `metar-ksfo.json`: NWS KSFO observation at 17:56 UTC, preserving both raw aviation
  groups and the rounded decoded metric fields that exposed the precision issue.
- `taf-ksfo.xml` / `.json`: KSFO IWXXM and matching coded bulletin, issued 17:27 UTC.
- `taf-ksfo-amended.xml` / `.json`: actual KSFO 20:33 UTC amendment; the XML bulletin
  identifier includes the WMO `AAA` suffix.
- `taf-pafa.xml` / `.json`: PAFA IWXXM and matching 17:20 UTC coded bulletin,
  exercising issuing-office lookup for the PAFA/FAI identifier difference.

NWS source entry points:
`https://api.weather.gov/stations/KSFO/observations`, station `tafs` lists and their
IWXXM resource URLs, `products/types/TAF/locations/SFO/latest`, and the `products`
query with the IWXXM issuing office and exact issue minute.

These seven files were moved unchanged from `test/fixtures/nws/`. The separate
[NOAA bulk METAR capture](../../../../../test/fixtures/nws/README.md) remains an
active parser/display regression fixture.
