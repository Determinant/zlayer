# Airport plates and offline documents

The airport picker, exact-page PDF.js viewer, whole-file document cache and regional
downloads are implemented. [Offline storage](offline-storage.md) owns the current
download, quota, integrity and readiness contract. Route-corridor selection and atomic
cycle migration below remain planned.

Offline is a product capability, not an accidental HTTP-cache hit. Browsing an opened
plate and verifying every dependency of a saved region are different promises.

## Publisher-owned indexing

`faa-regs` owns FAA d-TPP discovery/normalization and publishes `tpp/catalog.json`
and `tpp/manifest.json` under a dated chart directory. ZLayer consumes that catalog,
which retains:

- cycle/effective interval, volume, state/city and FAA/ICAO airport identifiers;
- original chart code, sequence, procedure ID, name and PDF filename;
- amendment, user-action/change-notice fields and source URL;
- normalized grouping, bound-volume section/printed page, and validated zero-based
  PDF page index where available;
- airport-specific named destinations in shared minimums documents.

Unknown chart codes stay visible as Other. Named destinations are separate from the
download URL: fragments select a location, not a different file or checksum. For example,
`sw2to.pdf#nameddest=(PAO)` targets Palo Alto within a shared takeoff-minimums PDF.

`npm run build:procedures` in `faa-regs` catalogs every current FAA record and indexes
the original combined volumes available locally; `build:charts` includes that stage.
It does not download one PDF per airport. Each record retains the individual FAA link
as well as its available book target. Advertised targets must resolve during publishing;
the client never guesses page indexes from printed numbers or extracted text.

Chart Supplements use independent `cs/catalog.json` metadata generated from FAA d-CS
XML and original books. Their 56-day edition can span two TPP cycles. Books alone do
not supply airport/page lookup; publish the index too.

## One viewer, every source

The airport **Plates** tab groups procedures by type. Airport diagrams come first,
followed by Chart Supplement entries; supplements also appear at VFR-only airports.
TPP and supplement metadata load independently so one failed source does not hide the other.

A row opens a slide-in dialog immediately; a loading skeleton remains visible while
the PDF.js renderer and document load:

- Hosted books open at their validated page index.
- Individual FAA fallbacks use the same viewer, through a narrow FAA-only proxy.
- Shared minima open at the named destination or validated page.
- Only the current page renders; closing/changing documents cancels obsolete rendering.
- Two-finger pinch and trackpad gestures change viewer zoom from 50–400%, anchored
  at the gesture. The current bitmap previews the movement; PDF.js redraws after
  release. Selection, page, zoom, fullscreen and scroll position restore locally.
  See [workspace persistence](contracts.md#workspace-persistence) and
  [gesture checks](responsive-checks.md#plate-modal-regression-checks).
- A named native modal handles initial focus, keyboard containment, Escape and focus
  restoration, while preserving the slide animation.
- The header's **Enter full screen** control expands the viewer to the browser
  viewport, with a compact title and touch-sized reading controls. Page and zoom
  stay selected, and the fitted page resizes when the device rotates. **Exit full
  screen** or Escape restores the panel; **Close plate** dismisses either mode.
  This works inside the app without requiring the browser's Fullscreen API.
- Source link and effective interval are visible in the standard panel and hidden
  in full screen to leave more room for the plate. “Open original” is explicit;
  the app never substitutes the browser's PDF renderer for its own viewer.

ZLayer presents the authoritative page, not an interpretation of minimums or operational
advice. Large books never load on map startup. Every airport using a book shares its
content-addressed URL; the selected page is independent of that cache key. Pacific
procedures and supplements pointing at the same book likewise share one stored file.

FAA PDF fallback needs same-origin/CORS-readable delivery. Vite provides
`/faa-procedures/<cycle>/<filename>.PDF` locally; production needs the equivalent
restricted proxy. Military HIGH procedures can be individual-only even with all TPP
books hosted, so the proxy is not merely a temporary missing-upload workaround.
See [deployment readiness](deployment-readiness.md).

## Document identity and reuse

Hosted books are keyed by published SHA-256 and size; individual FAA URLs include
the procedure export version. An individual fallback saves only that PDF, with actual
length and a locally computed integrity receipt, which is not a publisher checksum.

New downloads are fully verified before PDF.js receives them. Reuse checks the stored
PDF's type, header and length and uses a matching integrity receipt; missing or
mismatched receipts require hashing again. Concurrent opens share the download,
not a detachable PDF.js buffer.
An already-started whole-file download may finish caching after its viewer closes.
Invalid responses are discarded. Cache-write failure still permits online viewing,
but never an “Available offline” claim. Expired documents retain their actual interval.

Regional saves reuse these same files and always include applicable TPP/CS books and
required individual plates. They do not create duplicate document blobs. An advertised
but unresolved book page blocks completeness; an intentionally individual-only record
is handled through its FAA PDF. See [offline storage](offline-storage.md) for verification,
shared-file removal and device testing.

## Planned route packages and cycle migration

A future **Save route offline** action should inventory departure, destination,
alternates and a configurable corridor: chart coverage/zooms, reference/search data
and applicable procedures. Optional weather snapshots must retain their real times
and ordinary stale/expiration behavior. This is selective, not a nationwide preload.

Regional saves already capture immutable local catalog/reference identities and
activate a staged update only after verification, retaining the previous selection
on failure. Future route packages and cycle migration should reuse that lifecycle,
recording route/coverage identity and schema compatibility alongside product intervals
and artifact identities. Reuse shared files instead of copying cache namespaces.
See [ADR 0005](adr/0005-offline-snapshot-authority.md) for the remaining publisher and
storage-record proposals.

Route drafts and exact feature pins already survive restart. Settings can remove
unsaved chart/PDF files, and automatic cleanup protects saved and active data.
Shareable route URLs, corridor selection and automatic cycle migration remain future work.
Cached launch must stay interactive throughout background refresh and migration.

## Verification

A successful online open must reopen offline through PDF.js, including approach,
named-minimums and supplement pages. Test cancellation, corrupt bytes, denied storage,
source failures and keyboard focus. Complete regional saves must also survive restart
and browser eviction checks; see [release checks](offline-storage.md#release-checks).

## References

- [FAA d-TPP catalog](https://www.faa.gov/air_traffic/flight_info/aeronav/productcatalog/DigitalProducts/dtpp/)
- [FAA d-TPP XML definitions](https://aeronav.faa.gov/d-tpp/Metafile_XML_Definitions.pdf)
- [PDF.js viewer parameters](https://github.com/mozilla/pdf.js/wiki/Viewer-options)
- [PDF.js named-destination API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html)
