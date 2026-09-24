# Historical weather evidence

[AWC Weather](../README.md) / Validation

These September 22–24, 2026 records describe the sources, implementations and
environments sampled at the time. They do not establish that the current tree
passes, is deployed, or meets physical-device performance budgets. Keep their
original measurements and limitations intact.

| Records | Purpose and limits |
| --- | --- |
| `2026-09-22-advisories.json`, `2026-09-23-direct-advisories.json`, `2026-09-23-remaining-proxy-sources.json` | Advisory/source-access research, including direct-feed alternatives that did not become the current delivery contract. |
| `2026-09-22-grib.json`, `2026-09-22-ifi-horizon.json`, `2026-09-23-browser-grib.json` | Independent numeric decoding, vertical/horizon samples and browser conversion measurements. |
| `2026-09-22-grid-encoding.json`, `2026-09-23-grids.json` | Earlier encoding experiments and prepared-generation evidence; not the current packed-file contract. |
| `2026-09-23-hrrr-direct.json` | Sampled NOAA mirror equivalence and delivery observations. |
| `2026-09-23-timeline.json`, `2026-09-23-middle-timeline.json` | Numeric/image identity and stepping measurements before the current radar/Progs timeline. |
| `2026-09-23-rendering.json`, `2026-09-23-review-performance.json` | Scoped renderer timings; exclude acquisition or GPU work where stated and are not tablet benchmarks. |
| [Coded-bulletin evaluation](2026-09-24-coded-bulletins/README.md) | Superseded WPC inputs, preserved with source hashes outside the current test fixtures. |

The [grid guide](../grids/README.md), [Progs guide](../progs/README.md),
[radar guide](../radar/README.md) and [server guide](../../../../tools/weather-server/README.md)
own current contracts. Executable regressions use the source captures and independent
references under `test/fixtures/`; [local verification](../../../../docs/development/local-development.md#verification)
owns how those regressions run.
