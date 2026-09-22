# Verification evidence

These artifacts support specific findings in the documentation. They record the
source data, implementation and environment of a past check. For implementation
work, use the owning feature guide, [engineering guide](../development/engineering.md),
[data contracts](../data/contracts.md) and [ADRs](../README.md#decisions) for requirements
and design rationale. A historical passing result does not validate a later build
or supersede a current constraint, diagnostic or release gate.

## Retained records

| Evidence | Why it is retained | Owning guide |
| --- | --- | --- |
| [FAA 2609 state audits and geometry panels](approaches/2026-09-20/README.md) | Complete California/Arizona chart and entry inventories, policy-1/2 geometry, and national diagnostics with the KIWA comparison. Later policy summaries do not contain all these records. | [Approach coverage](../../src/layers/routes/approach-coverage.md) |
| [Chart/navigation cleanup](chart-nav-review/2026-09-21/implementation/README.md) | Publisher/client identity and coverage checks, original negative probes, national terminal findings, indexing measurements and route-history provenance. One full terminal report serves both guides. | [Terminal procedures](../../src/layers/routes/terminal-procedures.md) |
| [Early course capture](approaches/2026-09-21/intercept-capture/README.md) | Policy-3/4 comparison, general capture invariants and KVGT desktop/phone renderings. | [Approach geometry](../../src/layers/routes/approach-geometry.md) |
| [Planning connections](approaches/2026-09-21/planning-connections/README.md) | Preview/save/reload and terrain evidence for connections across unresolved route gaps. | [Route terrain](../../src/layers/terrain/README.md#verification) |
| [Policy-5 maneuvers](approaches/2026-09-21/maneuver-review/README.md) | Outbound-course capture, reversals, retained prefixes and national before/after diagnostics, including unresolved returns. | [Remaining approach cases](../../src/layers/routes/approach-coverage.md#policy-5-maneuver-review) |

## Retention rules

- Keep durable behavior, constraints and unresolved work in their owning guides;
  link evidence from those guides when it substantiates a claim.
- Keep source/implementation hashes, edition, geometry policy, scope and environment
  with measurements. Different policies or scopes are separate observations;
  do not combine their counts or relabel an older run as current verification.
- Retain unique diagnostic records, reproducible comparisons and representative
  screenshots that support a guide or unresolved issue. A newer screenshot of one
  procedure does not replace a national inventory or a distinct phone/terrain check.
- Prefer one complete report to duplicate exports. Before removing a derivative,
  compare its contents and preserve any unique provenance or findings elsewhere.
  Leave retained raw reports and images unchanged.
- Put new scratch scans, downloads, trial geometry and repeated test output in
  ignored `tmp/` or outside the repository. Promote only evidence with a documented
  purpose; update inbound links when consolidating it.
