# Active reviews

Keep dated reviews here while their investigation or unresolved findings still need
a standalone evidence record. Move lasting behavior and engineering requirements
into the owning guide after fixes land. Record remaining work in the roadmap or
validation guide, then remove superseded reports and duplicate intermediate output.
Dated test results never establish that a later working tree passes.

## Consolidated material

| Earlier reviews | Canonical home |
| --- | --- |
| AHRS methodology, v3–v6 revisions, completion criteria and superseded bias-only magnetic aiding | [AHRS validation](../ahrs-validation.md); equations remain in the estimator notes linked there. |
| iPhone retained memory and scrolling | [Memory/resource behavior](../memory-resources.md#ahrs-session-memory-and-scrolling). |
| Two source-review fix logs and HSI follow-ups | [Engineering recovery invariants](../implementation.md#recovery-and-source-identity), [layer behavior](../layer-modules.md), and the owning route/PDF/weather/recording guides. |
| O69, state/national coverage, branch/DME and chart-matching reports | [Approach coverage](../approach-coverage.md), including reviewed source associations and reporting exceptions; [geometry design](../approach-geometry-plan.md) and [historical evidence](../evidence/approaches/2026-09-20/README.md). |

Keep generated downloads, scratch scans and rejected trial geometry in ignored
working directories or outside the repository. Retain final JSON/CSV/figures only
when a guide relies on them for reproducible evidence. Generated coverage scans,
comparison ledgers and working reports belong in ignored `tmp/`, not here.
