# Superseded WPC coded-bulletin evaluation

[Historical weather evidence](../README.md)

Captured September 24, 2026 from NOAA WPC. These bulletins were evaluated before
the complete AWC chart GeoJSON adapter. They omit isobars and combine several
boundary meanings under TROF, so they cannot satisfy the current
[Progs contract](../../progs/README.md#source-and-weather-meaning).

No current parser or test consumes them. The gzip archives preserve the original
bytes, including whitespace, CR/LF and the analysis's terminal `$$`. Hashes below
apply to the decompressed source bytes.

| Archive | Source | SHA-256 |
| --- | --- | --- |
| `analysis.txt.gz` | https://www.wpc.ncep.noaa.gov/discussions/codsus_hr | `fe51ee75c5e3e8b7a567df029b034a062a9ff131aa43c83fbf19ddfe7007caf4` |
| `forecast.txt.gz` | https://www.wpc.ncep.noaa.gov/basicwx/coded_srp.txt | `f76c796e4d9c051c33c5b8b5ee1ef781b831c38695d171c9e35c8c972c08e5ed` |

The analysis was issued 16:34Z for 15Z. The forecast was issued 16:27Z and contains
five native times beginning September 25 at 00Z. These are historical inputs,
not current weather or evidence that the present implementation passes.
