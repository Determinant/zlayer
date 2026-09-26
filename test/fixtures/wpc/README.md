# NOAA surface-chart fixtures

Captured on 2026-09-24 from the public AWC Progs catalog and its listed WPC GeoJSON files. Original bytes are retained. This is source evidence for one catalog, not operational qualification.

Catalog: <https://aviationweather.gov/api/data/progchart>

Files: `https://aviationweather.gov/data/products/wpc/20260924/<filename>`. The catalog deliberately includes a 00Z-cycle F060 chart among 12Z forecasts. Tests preserve this identity and all feature properties.

`20260925_12_F072-isobar-excerpt.geojson` is a reserialized excerpt captured on
September 25 from
`https://aviationweather.gov/data/products/wpc/20260925/20260925_12_F072_wpc.geojson`.
It retains metadata record 0 and isobar record 178 from the original document
(SHA-256 `9a9b59c8e9dbdc600e333f9300886e77ae002013fbf7615e3fe5c7d464e440aa`).
Its 22 date-line crossings exercise partitioning into bounded features without
dropping any of the 23 line parts or 3,597 prepared positions. The excerpt's SHA-256
is `410bf6da5ac6807df65ecd36ad070a252c60469b0d111301358ad4455db67f7a`.

`awc-cardinal-reference.json` records output from AWC's own surface-rendering spline
on four synthetic control points, captured September 24, 2026. It retains the
public renderer asset URL/hash, coordinates and unrounded results (with duplicate
segment joins removed and longitude/latitude order restored). The regression
compares our server's curves to this independent output within five-decimal-degree
rounding precision. It tests spatial presentation, not forecast interpolation.

| File | SHA-256 |
| --- | --- |
| `2026-09-24-catalog.json` | `8c535f1509edcebf2402710f197b6e349d5616f6cd7fffc16be99c9bc9149efe` |
| `20260924_00_F060_wpc.geojson` | `1eb7aa8063db10e05d5b58b2f8c3b3f8df2eb90f6ebe312d3d141673bf064be4` |
| `20260924_12_F012_wpc.geojson` | `836c3830a1c6ae88f3e4c7f80c1259eb035c123a3044b780b2d6bd6571d7c00d` |
| `20260924_12_F018_wpc.geojson` | `cddc945cc9560eb8160bbde740a599e888320253379dcafd2cad490a883ecd0f` |
| `20260924_12_F024_wpc.geojson` | `441fbd40e5bee5b2d3969acbf874014c0213bfe944692ed63b87365a4e253d7f` |
| `20260924_12_F030_wpc.geojson` | `3ce9221e03f432410435838e1015d3c3e29ea5387ae025471777a7b77fb52f58` |
| `20260924_12_F036_wpc.geojson` | `e91ce1649b59efb7485a99583df605419934781db6e699cf2a17f51af2e5d4b5` |
| `20260924_12_F072_wpc.geojson` | `44cf52782fc69cb1f2f871edb541a3b533d3599d9842c1dc150e00d758f9861a` |
| `20260924_12_F096_wpc.geojson` | `e47d2c787add7586d631d9e5903de5f8335217c7dcad159a4329a90e4248b9fd` |
| `20260924_12_F120_wpc.geojson` | `9d4b20f03c9c255cca90d9876affa52104cbc72d56758040d9dd977ce5b42fb8` |
| `20260924_12_F144_wpc.geojson` | `6a4096daa0ca2c2674aa25ea38c8bab64738ab97e578dbabd66b0f9e1372bc8c` |
| `20260924_12_F168_wpc.geojson` | `684050ced36c68b62ff785abaa3582c39ec87d14152c5778e7a6110516c692c5` |
| `20260924_15_F000_wpc.geojson` | `db807f525689b132f69bd4ef2e491d8220f94575cc85bd002124ef207d59ded4` |

The unused coded-bulletin captures are archived with their
[historical source evaluation](../../../src/layers/weather-awc/validation/2026-09-24-coded-bulletins/README.md),
outside the active test fixtures. The current adapter consumes the chart GeoJSON above.
