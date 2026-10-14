# AWC aircraft reports, October 13–14, 2026

`2026-10-13.xml.gz` is an unmodified capture of the public AWC bulk file:
https://aviationweather.gov/data/cache/aircraftreports.cache.xml.gz

Retrieved October 13, 2026 around 06:29 UTC. It contains 2,098 records with
observation times from 04:59 to 06:28 UTC: 2,077 AIREPs, 19 routine PIREPs and
2 urgent PIREPs. The routine DEN report at 06:20 has AWC's `bad_location` flag;
the server must deliver it unchanged. The PWA must not trust its supplied
coordinate and may recover its raw `/OV` using an explicitly labeled assumption.

`2026-10-14.xml.gz` is another unmodified capture of that bulk URL, retrieved
October 14, 2026 at 21:37:37.459 UTC. Its byte SHA-256 is
`2e15e43d16520673b4ce4916dc20275d6ebcf6a62c064dade25b51d550678966`.
It contains 1,079 records observed from 20:08 to 21:37 UTC: 742 AIREPs, 336 routine
PIREPs and one urgent PIREP. Ten PIREPs carry `bad_location`: four AMA `FINAL 4`
reports and one each at LAS, ASE, OPF, LAF, APA and DPA. The latter exercise bare
radial/distance, distance-padding and compact compass recovery.

`test/pirep-corpus.test.ts` covers all 358 PIREPs in these two complete captures,
including the 11 bad-location recoveries, through map selection with the recorded
source-check time. It also checks that valid source positions and all original
observation fields remain intact. Unsupported raw headers or location phrases
are listed explicitly in the test; these reports remain usable through valid
source coordinates.

The October 14 parser refactor was compared against the preceding working parser
using both bulk captures and the five individual captures below: 3,182 reports,
including 363 PIREPs. Every derived report, position and label matched. A separate
raw `/OV` audit used the complete October 1 airport/NAVAID/fix collections and
the fixture WMM model. In the new bulk capture, 331 of 337 PIREP locations were
recognized and 323 resolved from raw text alone. Six had unsupported raw syntax
or headers; eight referenced unavailable navigation identities. All 337 still
plotted with valid source positions or bounded recovery. These are dated comparison
results, not a promise that all future free text can be recovered.

`2026-10-13-gfk.xml` retains the original GFK member from the published
`https://zlayer.tedyin.com/api/weather/pireps.json` response whose source-check time
was October 13, 2026 at 22:34:29 UTC. It carries `no_time_stamp`, structured
observation time 21:20Z and receipt 21:20:10.884Z, but its raw report says `/TM 2210`.
The conflicting times are deliberate source evidence, not corrected fixture data.
`test/pirep-time.test.ts` covers PWA recovery from that raw time and preserves the
other source fields. The original XML member is copied without rewriting it.

`2026-10-13-lwm.xml` and `2026-10-13-cybl-kbfi.xml` retain the two original
`bad_location` members from that same 22:34:29Z publication. Their raw locations
are `LWM23001` and `CYBL-KBFI`. These exercise distance-padding recovery and an
international route endpoint through both the raw and legacy wire formats.
`test/pirep-location-recovery.test.ts` follows decoding through map selection,
preserving raw evidence, altitude and negative turbulence.

`2026-10-14-forck.xml` and `2026-10-14-skn.xml` retain the original members from
the same public PIREP endpoint, checked October 14 at 02:01:30 UTC. Both carry
`bad_location`. The TRL report supplies `/OV FORCK270010`; its structured position
is near the reporting airport rather than the named fix. The SLN report supplies
`/OV SKN`, but its position `[-97.6213, 38.9251]` rounds to the published SLN VORTAC.
SKN has no exact airport, NAVAID or fix identity in this navigation edition.
Tests cover five-letter fix recovery and explicitly approximate, corroborated
identifier-typo recovery through both wire formats and map selection, with
negative cases for missing evidence, disagreements and ambiguous references.

`2026-10-14-ama-dep.xml` retains the exact AMA member from the public PIREP
endpoint checked October 15 at 00:09:30 UTC. Its observation time is October 14
at 23:41 UTC and its raw location is `/OV DEP 4`. AWC marks `bad_location`, supplies
the airport's rounded coordinate and encodes `altitude_ft_msl` as zero despite
`/FLDURC`, without an altitude quality flag. The sky layer is OVC from 4,500 to
5,300 ft MSL. The regression recovers a labeled runway-departure airport reference
through both wire formats, keeps aircraft altitude unknown and preserves the
complete original XML, times, cloud layer and quality flag.

`2026-10-01-locations.json` contains unchanged LWM/KBFI/SLN airport features,
LWM/MQP/SLN NAVAID features and the FORCK fix from the public October 1 navigation
edition, retrieved October 13–14. It also includes the AMA/LAS/ASE/OPF/LAF/APA/DPA/DEN
airports and all same-ID NAVAIDs for the bulk captures' bad-location recoveries.
This subset was compared with the complete national collections to confirm the
same derived results for the October 14 capture, including DPA's VOR precedence.
LWM is a DME without VOR alignment in this source; the LWM airport
bearing therefore needs WMM. CYBL is absent from the national airport collection
and uses the separately documented [AWC station reference](../../../src/layers/weather-awc/pireps/station-references.md).
The fixture is a small subset, not national reference coverage. Source files:

- [Airports](https://charts.tedyin.com/charts/2026-10-01/nav/airports.c091f077661dfead75099351fcac45a063324f6b6f73e6cd213f48d8aeca0256.geojson),
  byte SHA-256 `c091f077661dfead75099351fcac45a063324f6b6f73e6cd213f48d8aeca0256`.
- [NAVAIDs](https://charts.tedyin.com/charts/2026-10-01/nav/navaids.46e1811b8cdce0ac798d5fc9a4cd0cce7f61436b66dfbf12b920aad1b9d8013f.geojson),
  byte SHA-256 `46e1811b8cdce0ac798d5fc9a4cd0cce7f61436b66dfbf12b920aad1b9d8013f`.
- [Fixes](https://charts.tedyin.com/charts/2026-10-01/nav/fixes.634e7ac8342d60507a399a1d5867d63405f37d56dbb942d36369606414d47999.geojson),
  byte SHA-256 `634e7ac8342d60507a399a1d5867d63405f37d56dbb942d36369606414d47999`.

The source's schema is https://aviationweather.gov/data/schema/aircraftreport2_0.xsd.
`test/pireps.test.ts` covers complete-envelope accounting and verbatim server
delivery, then PWA decoding of reported altitude, hazard qualifiers and raw evidence. Synthetic
mutation tests cover malformed/truncated sources and recovery. Browser fixtures
are separately identified synthetic observations in `../pireps.ts`.
