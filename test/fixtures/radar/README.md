# NOAA radar captures

Captured 2026-09-24 from these public source files:

- `20260924-202439-mrms.grib2.gz`: https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MergedReflectivityQCComposite_00.50/20260924/MRMS_MergedReflectivityQCComposite_00.50_20260924-202439.grib2.gz
- `20260924-202234-tokc.level3`: https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.180z0/SI.tokc/sn.last
- `20260924-202301-tatl.level3`: https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.180z0/SI.tatl/sn.last

`provenance.json` pins original byte lengths and SHA-256 hashes. TDWR URLs are mutable;
filenames identify the observation in the saved bytes. These weather situations are
historical test inputs, never live weather.

Independent `gdalinfo -json -stats /vsigzip/<MRMS file>` reported 7000×3500 cells,
WGS84, upper-left pixel edge approximately -130°,55°, steps +0.01°,-0.01°,
observation time 1790281479 seconds, zero forecast lead, units dBZ, parameter
209/10/0, minimum -999 (missing), and maximum 65.5. `gdal_translate -of XYZ -srcwin`
reported cell (3318,1580) = 39 dBZ at -96.815°,39.195° and (3059,1933) = 42 dBZ at
-99.405°,35.665°. PNG packing is GRIB template 5.41.

Independent Python `bz2.decompress` and `struct` reads of TOKC found station
35.276°,-97.510°, observation 20:22:34Z, 360 radials, 592 gates, first azimuth
25.7°, and initial gate codes `[0,43,29,29,24]`. The product's threshold table maps
those to missing, -11.5, -18.5, -18.5 and -21 dBZ. TATL contains 358 measured
radials and a missing two-degree sector, which exercises partial-sweep handling.

Sources are U.S. government weather observations. Format references are linked in
the [Radar guide](../../../src/layers/weather-awc/radar/README.md).

STI/product 58 captures are pinned in `motion-provenance.json`. KTLX contains two
forecast tracks (N1 and I1) at 15-minute intervals through +60 minutes; its tabular
block independently lists N1 at 240°/117 nm and +60 at 250°/99 nm. KAMX contains
one projected track (N5) and a new cell (R1) without motion. KHTX is a valid empty
report with no symbology block. Headers and ASCII tables were inspected from the
captured source bytes. `test/weather-radar-motion.test.ts` exercises those source
semantics; capture provenance is independent of the current test result.
