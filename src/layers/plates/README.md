# Airport plates and offline documents

[Documentation](../../../docs/README.md) / Plugins / plates

The [core plugin bridge](../../../docs/architecture/layer-plugins.md#inter-plugin-communication)
exposes the public `open` command, `opened` notification and optional map context action.
The workspace observes `opened` to select the reader panel. Data-only catalog readers
remain usable independently of the viewer plugin’s enablement.
`data.ts` owns `procedureSelection`, used by the airport list and route pickers
to carry the same document target and edition metadata into the viewer.

The airport picker, exact-page PDF.js viewer, whole-file document cache and regional
downloads are implemented. [Offline storage](../../../docs/features/offline-storage.md) owns the current
download, quota, integrity and readiness contract. Route-corridor selection and atomic
cycle migration below remain planned.

Offline is a product capability, not an accidental HTTP-cache hit. Browsing an opened
plate and verifying every dependency of a saved region are different promises.

## Contents

- [Publisher-owned indexing](#publisher-owned-indexing)
- [One viewer, every source](#one-viewer-every-source)
- [IAPs on the map](#iaps-on-the-map)
- [Document identity and reuse](#document-identity-and-reuse)
- [Planned route packages and cycle migration](#planned-route-packages-and-cycle-migration)
- [Verification](#verification)
- [References](#references)

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

- File acquisition uses core's [shared transfer framework](../../../docs/architecture/layer-plugins.md#file-downloads),
  including exclusive scheduling, bounded disk writes and failed-file cleanup.
  Plates owns PDF validation and progress presentation; it has no separate transfer queue.
- Hosted books open at their validated page index.
- Individual FAA fallbacks use the same viewer, through a narrow FAA-only proxy.
- Shared minima open at the named destination or validated page.
- Only the current page renders; closing/changing documents cancels obsolete rendering.
  Document-load, target-resolution and page-render failures release the PDF.js loading
  task and worker; cleanup rejections do not create an unhandled promise rejection.
- A newly opened plate fills the available reading width at 100% zoom and starts
  at the top; taller pages scroll vertically. The width fit follows panel resizing,
  fullscreen and rotation. A stable scrollbar gutter keeps vertical overflow from
  repeatedly changing the fitted width. Saved zoom and scroll position take precedence when
  reopening a plate.
- Reading controls inherit core's B612 button type and line height, with 14px
  values and 11px secondary labels using the shared muted color. They stay on one
  line with 44px targets. In narrow
  readers, the **Page** button opens previous/next navigation and **Open original**;
  Escape, Back or tapping outside dismisses the picker. The side reader's offline
  status remains visible below the controls. The percentage is a **Reset plate view** button:
  it restores 100% width fit, the original orientation and the top of the current
  page, keeping the selected page and fullscreen mode.
- Two-finger pinch and trackpad gestures change viewer zoom from 50–400%, anchored
  at the gesture. The current bitmap previews the movement; PDF.js redraws after
  release. Compact zoom controls leave room for **Rotate 90° clockwise**, which
  turns the page in quarter turns and refits it at the selected zoom, starting at
  the top of the rotated page. The PDF's original orientation is preserved as the
  starting point. Selection, page, zoom, rotation, fullscreen and scroll position restore locally.
  See [workspace persistence](../../../docs/data/contracts.md#workspace-persistence) and
  [gesture checks](../../../docs/features/shared-ui.md#plate-modal-regression-checks).
- The side reader is non-modal, so the map stays usable. Its core-owned
  `PanelSurface` enters native modal presentation only in fullscreen, handling
  initial focus, keyboard containment and Escape. The existing edge-panel host
  supplies stowing, slide transitions and tab focus; explicit close restores the
  opener or its airport tab.
- The header's **Enter full screen** control expands the viewer to the browser
  viewport, with a compact title and touch-sized reading controls. Page, zoom and rotation
  stay selected, and the fitted page resizes when the device rotates. **Exit full
  screen** or Escape restores the panel; **Close plate** dismisses either mode.
  This works inside the app without requiring the browser's Fullscreen API.
- Side-panel, stowed and fullscreen presentations retain the same mounted reader
  and canvas. Stowing keeps page, zoom, rotation and scroll, and a pending download can finish
  without reopening the panel. The first Escape/PWA Back leaves fullscreen; the
  next stows the side panel. Explicit close clears the selection; disabling the
  plugin releases the reader while keeping saved selection and reading state.
- Source link and effective interval are available in the standard panel and hidden
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
See [deployment readiness](../../../docs/development/deployment.md).

## IAPs on the map

Open an approach from an airport's **Plates** tab and select the **Show on map**
map icon in the header, immediately left of the full-screen button.
The viewer closes and the map fits the plate. Only one IAP can be shown: a new
selection replaces the previous overlay once its geographic data and image are
ready. Opening or closing the normal PDF viewer leaves the current overlay alone.

Right-click or long-press inside the plate to open its menu. **Show plate panel**
opens that overlay's exact plate and edition in the reader, restoring its saved
reading state while keeping the overlay and map view. **Hide IAP from map** removes
the overlay. Opening or dismissing the menu leaves the plate in place;
Escape or clicking outside closes the menu. Once the plate is ready, no status
banner covers the map. Panning, pinching and gestures outside the plate retain
their normal map behavior. The overlay restores after
reload from its exact saved PDF/approach target, including offline when the PDF
is cached. Restoration preserves the saved camera and other panels; explicit
hiding clears the saved overlay. A failed restore offers Retry/Hide and retains
the selection. Cancelled work cannot replace a later selection or revive a hidden
overlay; an already-started shared download may still finish caching. See the
[saved workspace inventory](../../../docs/architecture/workspace-persistence.md).

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
The reader and map restoration share one live PDF.js document and worker for the
same URL, SHA-256 and byte length, even when displaying different pages. Sharing
only the cached Blob is insufficient: PDF.js allocates a book-sized backing buffer
for each range-backed document. Closing either consumer releases only its own
reference; the last consumer destroys the worker. Publishing a completed map image
does not wait for worker teardown. Session failures remain observable after the
document opens: pending PDF reads stop with the original error, the reader leaves
its busy state, and map restoration exposes Retry/Hide. Closing one consumer still
leaves the other consumer's reads active. PDF.js 6.3.289
provides the fixed page-extraction implementation; the earlier 5.4.624 release
fails on null references in real FAA pages.

`test/plate-georeference.test.ts`, `test/plate-map.test.ts` and
`test/e2e/plate-map.spec.ts` cover placement validation, single-overlay lifecycle,
stale work, reopening the reader and explicit removal from the right-click/long-press
menu, panning, unsupported pages and offline reuse. `test/e2e/plate-menu.spec.ts`
covers keyboard navigation and dismissal focus. The existing plate rendering,
fullscreen and pinch tests cover the PDF.js upgrade.

## Document identity and reuse

Hosted books are keyed by published SHA-256 and size; individual FAA URLs include
the procedure export version. An individual fallback saves only that PDF, with actual
length and a locally computed integrity receipt, which is not a publisher checksum.

New downloads are fully verified before PDF.js receives them. Reuse checks the stored
PDF's type, header and length and uses a matching integrity receipt; missing or
mismatched receipts require hashing again. Concurrent opens share the download;
live readers and map restoration also share their PDF.js document through
`pdf-document.ts`, without transferring a reader-owned buffer.
An already-started whole-file download may finish caching after its viewer closes.
Invalid responses are discarded. Cache-write failure still permits online viewing,
but never an “Available offline” claim. Expired documents retain their actual interval.

Regional saves reuse these same files and always include applicable TPP/CS books and
required individual plates. They do not create duplicate document blobs. An advertised
but unresolved book page blocks completeness; an intentionally individual-only record
is handled through its FAA PDF. See [offline storage](../../../docs/features/offline-storage.md) for verification,
shared-file removal and device testing.

When published for the saved edition, the region also retains coded approach routes,
entries and fixes. A new route can be planned offline: attach an approach to an airport,
choose a published entry or VTF, switch approaches, and draw the selected route without
opening that approach online first. Existing regions need **Verify / update** to acquire
approach data added after their download. See [anchored approaches](../routes/README.md#anchored-approaches).

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
See [ADR 0005](../../../docs/adr/0005-offline-snapshot-authority.md) for the remaining publisher and
storage-record proposals.

Route drafts and exact feature pins already survive restart. Settings can remove
unsaved chart/PDF files, and automatic cleanup protects saved and active data.
Shareable route URLs, corridor selection and automatic cycle migration remain future work.
Cached launch must stay interactive throughout background refresh and migration.

## Verification

A successful online open must reopen offline through PDF.js, including approach,
named-minimums and supplement pages. Test cancellation, corrupt bytes, denied storage,
source failures and keyboard focus. Complete regional saves must also survive restart
and browser eviction checks; see [release checks](../../../docs/features/offline-storage.md#release-checks).

## References

- [FAA d-TPP catalog](https://www.faa.gov/air_traffic/flight_info/aeronav/productcatalog/DigitalProducts/dtpp/)
- [FAA d-TPP XML definitions](https://aeronav.faa.gov/d-tpp/Metafile_XML_Definitions.pdf)
- [PDF.js viewer parameters](https://github.com/mozilla/pdf.js/wiki/Viewer-options)
- [PDF.js named-destination API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html)
