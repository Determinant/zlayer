# AWC G-AIRMET bulk/GeoJSON comparison

`gairmets.xml.gz` is the unmodified official complete cache download. The
independently downloaded five GeoJSON frames are compressed in
`reference.json.gz`. Acquisition times, source URLs and hashes are in
`provenance.json`. Both represent the October 9, 2026 21:00 UTC package.

The regression compares all 149 records as a multiset, including coordinates,
geometry, hazard, identifiers, issue/valid/receipt times, forecast hour, altitude
and severity. Tags are not unique: multiple regions and freezing levels can have
the same tag and hour. Three closed FZLVL contours have XML `geometry_type=AREA`
but are LineStrings in AWC GeoJSON; FZLVL denotes an isoline. M_FZLVL remains an
area. XML numeric heights are feet; GeoJSON heights are hundreds of feet. XML's
`SFC00`, `null00`, empty and `-1` encodings are retained in original evidence while
mapped to the corresponding surface/missing values.

The cache's advertised XSD differs from its actual element names and altitude
structure. The adapter recognizes the captured published envelope, validates
counts and times, and preserves every original member as structured XML evidence.
Unknown geometry stays an explicit source issue. A gzip/DTD/envelope/count/time
failure rejects the complete replacement.

AWC recommends the [minute-updated full cache](https://aviationweather.gov/data/api/#cache-files)
for complete datasets. These U.S. government source records contain no application
user data or production credentials.
