# AWC NDFD image fixture

Captured September 25, 2026 from
<https://aviationweather.gov/data/products/wpc/20260925/20260925_03_F000_ndfd_sfc_wx_m.png>.
The original 1800 × 1200 RGBA PNG is retained without re-encoding. It exercises
image validation against an actual AWC product; it is not current weather.
SHA-256: `52373c1b860ab014429111f9cc6bd11743a4b7d0865565a0f6aefa1b9e2cf06e`.
`../progs-coverage.ts` supplies synthetic colors for deterministic renderer tests.

Bounds and legend were checked against AWC's operational GFA page and
<https://aviationweather.gov/assets/map-BY_ek-uh.js> on the same date.
The image carries no embedded valid or issue time. Its source filename supplies
chart reference/valid identity; the reference is not an NDFD model run.
