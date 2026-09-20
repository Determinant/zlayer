# ADR 0004: Offline packages and procedure documents

- Status: accepted
- Date: 2026-09-12

## Context

ZLayer is intended to become a fast, offline-capable route and weather planner. A
generic service-worker cache cannot prove that a route's charts and procedures are
complete, current, or retained. Loading regional TPP books also makes airport-level
procedure access unnecessarily slow.

FAA d-TPP metadata already maps airports to individual procedure PDFs. Its shared
takeoff/alternate/radar-minimum documents expose airport named destinations.

## Decision

- Treat offline data as explicit, checksummed route/region packages with staged and
  activated states.
- Keep the application shell, opened PDFs, and viewed immutable chart archives in Cache
  Storage. Use IndexedDB for catalog and explicit region selection records; resume
  by checking those same verified whole-file cache entries. OPFS is not required for
  this access pattern and would not provide a separate storage quota.
- Open a regional MBTiles archive only when its bounds intersect the viewport. On first
  access, download and cache that complete file as one object; coalesce concurrent reads
  and serve the worker's SQLite byte ranges from the cached `Blob`.
- Reuse or promote those whole-file cache entries when building an explicit, verified
  route/region offline package.
- Make `faa-regs` the sole d-TPP ingestion owner and consume a cycle-versioned airport
  procedure catalog in ZLayer.
- Prefer a locally indexed combined TPP at its builder-verified page. Retain the FAA
  individual PDF or named destination as a fallback in the same PDF.js viewer.
  FAA-hosted fallbacks require the narrow FAA proxy because the origin lacks CORS;
  the browser-native viewer is available only through the explicit source link.
- Cache each successfully opened procedure PDF by immutable cycle and artifact ID;
  discard incomplete responses and retain visible cycle/expiration metadata.
- Keep this on-demand document cache distinct from verified route/region packages.
  Full TPP downloads and cache-management controls remain explicit user actions.
- Lazy-load PDF.js outside the initial map bundle and retain a direct FAA/native-viewer
  fallback.
- Start from cached local state and refresh in the background; data synchronization
  never gates map interaction.

## Consequences

The app can report a saved region's verified file coverage and open the requested
airport page without searching a full book. Storage quota UX, resumable regional
downloads and eviction checks are implemented in Settings; see [offline storage](../offline-storage.md).
Committed snapshots now control regional reads, with verified staged activation and
exact reference identities; [ADR 0005](0005-offline-snapshot-authority.md) records the
client lifecycle and remaining publisher/storage proposals. Route-scoped completeness
and automatic cycle migration remain future work. Physical
device airplane-mode tests are required before release.

This architecture supports a future quick-EFB product direction but makes no claim
that the planning PWA is an approved or certified EFB.
