# Engineering guide

## Repository

```text
src/                   React/Vite PWA: product layers, shared core, workspace shell
public/                static app assets
test/                  unit tests, browser fixtures and Playwright regressions
tools/                 import checks, local proxies, offline shell and boundary builder
packages/contracts/    shared data types and runtime document guards
packages/domain/       framework-free routing, search and weather logic
docs/                  contracts, decisions and verification guides
.github/workflows/      verification and production-build browser CI
```

The root package owns the application. Only the shared packages are npm workspaces;
development tooling is not a second application. Production publishes static `dist/`
and consumes the dated artifacts built by `faa-regs`.

## Keep it simple

- Build the smallest design that satisfies a current use case.
- Prefer direct data flow and plain functions over framework or abstraction layers.
- Keep related logic together; split a module when it has a distinct responsibility,
  not merely to meet a line-count target.
- Add an interface, adapter or plugin boundary only for a concrete need.
- Fail visibly on ambiguous aviation data instead of hiding uncertainty behind heuristics.
- Preserve raw FAA/AWC identifiers, properties and times behind concise presentation.
- Use the shared [date, time, and currency formats](date-time-display.md) for UI labels.
- Validate external documents before application state or durable storage accepts them.
- Test observable behavior and failure recovery, not source text or incidental markup.

One persistent map, product-owned lifecycle, exclusive chart bases with additive
overlays, and whole-file MBTiles caching are deliberate constraints, not incidental
implementation details. Changes must preserve them or document a measured reason
to revise the design. Opportunistic caching must never imply verified regional
completeness.

## Where to look

- [Architecture](architecture.md): runtime, rendering order and chart I/O invariant.
- [Layer modules](layer-modules.md): feature ownership and evolving internal boundaries.
- [Local development](local-development.md): configuration, compatibility traps and tests.
- [Chart feed](chart-feed.md), [contracts](contracts.md) and
  [procedures](offline-procedures.md): publisher/client boundaries.
- [Offline storage](offline-storage.md): downloads, integrity, quota, recovery and reset.
- [AHRS](../src/layers/ahrs/README.md): experimental sensors, instruments and recordings.
- [Roadmap](roadmap.md): implemented baseline versus remaining work.

Before committing, run `npm run verify`; run `npm run test:browser` for the built-app
regressions used in CI. Rendering changes also need the targeted
[graphics matrix](graphics-compatibility.md#run-the-checks). Browser focus, touch/layout, installed-device offline behavior
and performance also need the separate checks in
[responsive checks](responsive-checks.md), [offline release checks](offline-storage.md#release-checks)
and [deployment readiness](deployment-readiness.md); a passing Node suite is not device certification.
