# Supplemental station references

The workspace navigation feed supplies FAA NASR airport and VOR references.
International endpoints such as `CYBL` in `/OV CYBL-KBFI` need additional coverage.
`station-references.json` bundles 4,957 international METAR/TAF station coordinates
from AWC for PWA location recovery, about 128 KiB before compression. It is an
offline reference snapshot, not a complete world airport or NAVAID database.

Only exact four-letter ICAO identifiers are included. Records must name a country
other than the US, advertise METAR or TAF service, and have finite, in-range
coordinates. FAA/IATA aliases, identifier-prefix guesses and unknown positions
are excluded. The US continues to use the workspace's edition-qualified NASR
references. Six otherwise eligible source entries contain invalid sentinel
coordinates and are excluded: HERT, HTJN, MMGA, OERS, VEHO and WAFB.

The lookup runs only after both workspace reference collections arrive and only
when no matching navigation identity exists. It cannot override an ambiguous
identity or replace a reference whose station alignment is missing. An AWC weather
station position is not necessarily the airport reference point: use is marked
**Approx. location**, with **AWC station reference: CYBL** (or the relevant IDs) in
the location details. It cannot supply an assumed reporting airport or an approach
reference. Explicit bearing/distance offsets still require WMM; weather station
metadata does not provide VOR alignment. Every route endpoint must resolve before
the existing geodesic midpoint is computed.

The compact table loads with the weather plugin. Lookup creates a reference only
for a requested identifier; it does not turn the table into thousands of map
features, add requests or polling, or repeat work on hover/map movement. Replacing
workspace references invalidates derived positions as before. Raw AWC reports
and server delivery remain unchanged.

## Source and regeneration

Source: [AWC station cache](https://aviationweather.gov/data/cache/stations.cache.json.gz),
retrieved October 13, 2026. AWC documents it as a daily worldwide station listing
in its [Data API guide](https://aviationweather.gov/data/api/). The downloaded
collection contains 9,947 entries. SHA-256 of the uncompressed JSON bytes:
`63c3d39b73de7a0cfa1b5cc5889dff61c9b1e9ba3b394673f3765804d92f1945`.
These are public US government reference facts. The bundle retains only identifiers
and coordinates, including CYBL at 49.951° N, 125.269° W.

From the repository root:

```sh
node tools/generate-pirep-stations.mjs /path/to/stations.cache.json.gz
```

The generator bounds decompression, pins the source hash, checks source/output
counts and missing-coordinate identities, and rejects duplicate identifiers.
Before refreshing the bundle, inspect the new source and coordinate/identity
changes, update the pin and coverage expectations, and retain the retrieval date
and hash here. Refresh it when preparing a release that changes PIREP reference
coverage; a newly assigned or relocated station can be absent or outdated between
updates. Do not add one-off report-specific coordinates. A future live international
reference feed should keep the same source-identity and fallback rules.
