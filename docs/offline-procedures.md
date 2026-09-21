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
Results remain tied to the selected airport and exact catalog resources; changing
editions hides the previous results immediately, before replacement requests finish.

A row opens a slide-in dialog immediately; a loading skeleton remains visible while
the PDF.js renderer and document load:

- Hosted books open at their validated page index.
- Individual FAA fallbacks use the same viewer, through a narrow FAA-only proxy.
- Shared minima open at the named destination or validated page.
- Only the current page renders; closing/changing documents cancels obsolete rendering.
  Document-load, target-resolution and page-render failures release the PDF.js loading
  task and worker; cleanup rejections do not create an unhandled promise rejection.
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

## IAPs on the map

Open an approach from an airport's **Plates** tab and select the **Show on map**
map icon in the header, immediately left of the full-screen button.
The viewer closes and the map fits the plate. Only one IAP can be shown: a new
selection replaces the previous overlay once its geographic data and image are
ready. Opening or closing the normal PDF viewer leaves the current overlay alone.

Right-click or long-press inside the plate to open its menu, then select
**Hide IAP from map**. Opening or dismissing the menu leaves the plate in place;
Escape or clicking outside closes the menu. Once the plate is ready, no status
banner covers the map. Panning, pinching and gestures outside the plate retain
their normal map behavior. The overlay restores after
reload from its exact saved PDF/approach target, including offline when the PDF
is cached. Restoration preserves the saved camera and other panels; explicit
hiding clears the saved overlay. A failed restore offers Retry/Hide and retains
the selection. See the [saved workspace inventory](workspace-state.md).

Placement comes from the selected PDF page's embedded geographic viewport,
control points and projection, including the FAA's Lambert Conformal Conic data.
The plate retains its printed content; geographic alignment applies to the
plan view, not the profile, minima or inset diagrams. The client does not infer
placement from the airport location. Missing, ambiguous, unsupported or
inconsistent metadata leaves the normal viewer available and preserves any
existing overlay.

PDF.js extracts only the selected page for the lazily loaded metadata reader.
The raster is reprojected to Web Mercator with a mesh, with at most 4,194,304
pixels (16 MiB of RGBA data) per canvas and 3,072 pixels per side. The temporary
PDF render canvas is released after reprojection. Replacing or removing an
overlay releases its canvas and map source. The same verified PDF cache supports
offline reuse; a selected overlay retains its document against automatic cleanup.
Restoration releases its PDF worker once the bounded map image is ready. PDF.js 6.3.289
provides the fixed page-extraction implementation; the earlier 5.4.624 release
fails on null references in real FAA pages.

`test/plate-georeference.test.ts`, `test/plate-map.test.ts` and
`test/e2e/plate-map.spec.ts` cover placement validation, single-overlay lifecycle,
stale work, explicit removal from the right-click/long-press menu, panning, unsupported pages and offline
reuse. The existing plate rendering, fullscreen and pinch tests cover the PDF.js
upgrade.

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

When published for the saved edition, the region also retains coded approach routes,
entries and fixes. A new route can be planned offline: attach an approach to an airport,
choose a published entry or VTF, switch approaches, and draw the selected route without
opening that approach online first. Existing regions need **Verify / update** to acquire
approach data added after their download. See [anchored approaches](routes.md#anchored-approaches).

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
