# Offline storage and downloads

[Documentation](../README.md) / Features

The gear button opens **Settings**. Regions are U.S. states and territories.
Every new region selection includes VFR and IFR low charts at every native zoom,
airport/fix/NAVAID/waypoint and airway data, and all applicable plates and Chart
Supplements. There is no charts-only or omit-books option. Complete books can be
large; books shared by several regions are stored only once. Procedures without a
bound-book target (including military HIGH plates) are saved as individual FAA PDFs
through the same narrow proxy and cache used by the viewer. They are required files,
not omitted warnings. An advertised book target with an unresolved page still blocks
the region until the index is corrected.

When the feed publishes `charts/terrain/manifest.json`, new selections also include
terrain DEM zooms 1–13. Regional preparation reads immutable spatial indices and
adds the necessary elevation archives before the quota preflight and file transfers.
The displayed initial size is a minimum until terrain preparation has finished.
Indices and DEMs have published sizes and SHA-256 hashes and share the whole-file
archive cache used by the terrain renderer. Regional verification checks required
index membership as well as retained file receipts. Terrain is independent of FAA
cycles; unchanged archives are shared across regions and cycles.

Existing selections retain their original scope until **Verify / update**. Settings
labels downloads that do not include terrain, including selections from feeds where
terrain has not yet been published. Publishing the terrain product does not add bytes
to a previously saved region automatically.

Regional saves include the optional national preferred/TEC, SID/STAR, approach and historical
route references when published. Each export is shared once per identity in the same
reference cache used by routing. **Verify / update** adds newly available references
to an existing selection without re-fetching verified charts or books. Older feeds
remain usable with missing route data shown as unavailable.
History stays gzip-compressed in storage; decoding, validation and airport-pair
indexing run in a worker. Offline checks validate the stored response, not worker
memory. See [routes and recommendations](../../src/layers/routes/README.md#recommendations) for UI behavior
and [contracts](../data/contracts.md) for reference identities.

Sizes include the published chart/book bytes. Individual-only FAA PDFs have no
published size or checksum: the UI labels their sizes as pending, records their actual
length and a local SHA-256 receipt when cached, and includes those bytes in saved totals.
That receipt records the completed verification; it is not a publisher-supplied checksum.
The quota preflight covers known sizes only; any additional write failure leaves the
selection incomplete and retryable. Shared navigation and
catalog metadata add space once; **App storage** shows the browser's actual origin
usage/quota estimate. Overlapping selections' displayed sizes are not additive.
While book indexes are loading or unavailable, the UI does not present a chart-only
subtotal as the full selection's size, and downloading that selection is disabled.

## Contents

- [Geographic regions](#geographic-regions)
- [Storage contract](#storage-contract)
- [Offline launch and scope](#offline-launch-and-scope)
- [Automatic online-cache expiry](#automatic-online-cache-expiry)
- [Release checks](#release-checks)

## Geographic regions

`src/offline/regions.ts` contains the 50 states, DC and five inhabited U.S.
territories, independently of FAA chart-sheet names. Only regions intersecting
published source-chart coverage are offered. Their conservative chart rectangles
come from the [Census 2024 States 500K layer](https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2024/State_County/MapServer/7):
query all features with `outFields=NAME,STUSAB`, `outSR=4326`, `f=geojson`; take
coordinate extrema and round west/south down and east/north up to 0.01 degree.
For Alaska, calculate separate extrema for negative and positive longitudes before
rounding. MP/VI names are shortened to match FAA supplement state names. These are
download envelopes used only to select archive files.

`region-boundaries.json` supplies the shared display-ownership masks. It is derived
from the same Census layer using `node tools/build-region-boundaries.mjs`: simplify
all states together with mapshaper 0.7.61, Douglas-Peucker, 100 metre interval,
`keep-shapes`, and TopoJSON quantization of 36,000,001 steps (at most roughly one
metre per longitude step). Shared borders retain shared topology. TopoJSON stores
shared, delta-encoded arcs once; only requested states are decoded and projected.
The source GeoJSON SHA-256 is
`f6ae66df079499025e3b752ca04e5d0b1a7c1a01b90cce34aff8ec75f2b7135a`.
These generalized boundaries select editions; they are not navigational boundaries.
They are bundled with the app shell and require no additional service when offline.
Point selection, chart clipping and viewport badges use the same Mercator geometry,
including holes, islands and both sides of the date line. Legacy unnamed selections
continue to use their saved rectangular coverage.

The planner selects every intersecting spatial/zoom archive, across all chart
families, directly from the existing manifest. Rectangles and archive grids include
some neighboring coverage. No MBTiles rebuild, republish, or second file layout is
needed. Books are selected by TPP/CS state membership and national NASR airport
identifiers (Pacific TPPs use `XX`). NASR airport membership uses the same geographic
mask as displayed charts; catalog state membership additionally includes books whose
airports are absent from NASR.
The airport index is not clipped to published chart footprints for this purpose.

Legacy chart-footprint selections remain resumable/removable. New state selections
have distinct IDs but reuse the same immutable file URLs and cache namespaces.
Resume uses the saved full plan when fresh book indexes are loading or invalid;
it must never replace a saved book list with a temporary chart-only estimate.

## Storage contract

### Stored files

Cache Storage holds small complete MBTiles/PDF files, metadata, viewed basemap
resources, and the application shell. New large files stream into origin-private
file storage; Cache Storage holds their small receipts. SHA-256 and length are
verified before a chart or book is published as available; unverified disk files
are never exposed by a receipt. Region downloads use exactly the same content-addressed
book/chart URLs and cycle/export-versioned individual PDF URLs as the map/viewer.
Previously viewed individual PDFs receive a local integrity receipt on reuse without
another download. Never introduce persistent per-tile entries, remote SQLite
page fetching, or duplicate offline copies of whole files.

Large transfers await 64 KiB writes and require writable local file storage.
The fallback retains at most 8 MiB; lack of storage must fail cleanly instead of
accumulating an entire book in RAM. Receipts resolve only to existing files of the
recorded size. Receipts live in separate cache namespaces so older open pages
cannot invalidate them; legacy complete entries remain readable. Concurrent
publishers reuse matching verified files. Removal makes an entry unavailable
immediately, while backing files stay readable for existing viewers until their
file handles are released. Full reset stops readers before deleting all files.
Interrupted uncommitted files are cleaned up; files orphaned by process termination
become eligible for cleanup after a day, with live readers and writers protected. See the
[KVGT iPhone download constraint](../verification/memory-resources.md#iphone-download-constraint-kvgt-2026-09-21)
for browser support, allocation bounds and physical-device validation.

### Catalogs and verification

IndexedDB holds discovered catalogs, immutable saved catalog snapshots, cache
access times, and small region selection records. Each completed selection names a
shared snapshot by its content digest; two regions from the same build do not
duplicate the catalog. The effective date alone does not identify a publisher build.

The same database also stores AHRS recording metadata and bounded JSON Lines
chunks under `ahrs-recording:` and `ahrs-samples:`. They are owned by the AHRS
toolbox, remain available for offline download after reload, and are removed by
the full local-data reset. Recording metadata and each chunk commit atomically.
See [AHRS recordings](../../src/layers/ahrs/recording.md) for format and retention limits.

Saving selection intent precedes transfer. Reopening Settings checks the actual
cache entries and their verification receipts; a stored percentage is not proof
that the browser retained the bytes. Reference documents must also pass their
ordinary loaders' schema, cycle and manifest-count guards. Selection records retain
those expectations, so a structurally valid but truncated reference file cannot
produce a “Saved” claim. This check is cache-only; identical reference expectations
are validated once per verification pass, and a later check revalidates them.
If a region's storage check throws, Settings keeps that region visible with a retry
action and continues checking the other selections. A check does not imply that
the selected FAA cycle is current.

Chart reads validate their cached content before use. PDF reads check the response type,
PDF header and actual length, and reuse the saved SHA-256 receipt when it matches
the requested book identity and stored length. This avoids rescanning a whole book
on every opening, including after an app restart. New downloads and entries without
matching receipt metadata still require full hashing. Legacy URL migrations reuse
a receipt only when it matches the current book identity and actual length. A reused receipt
trusts the previously verified stored bytes; it does not detect arbitrary
same-length content changes under an unchanged receipt.

TPP metadata must match the export timestamp in its `v` URL parameter. New saves
and **Verify / update** capture `jsonSha256`, the SHA-256 digest of each validated
parsed JSON export: navigation, airways, preferred routes, SID/STAR and approach routes,
historical routes and TPP metadata. Preparation persists these identities in both
the staged catalog and reference expectations before transferring files or activating.
Saved cache URLs include the digest, allowing builds at the same publisher URL to
coexist; product memory caches also include identity. Every saved read and repair
validates the digest as well as schema, cycle and counts. Compressed history stays
compressed in storage and is captured in its existing worker.
Snapshot capture parses and hashes one acquired response, then pins those exact
bytes. It does not reopen and rehash a mutable cache URL to make the snapshot copy.
Later cache checks still validate the saved JSON contents, schema and expected
digest; an in-memory result cannot prove that a persistent copy survived eviction.

Older records without a digest use surviving cached references only; eviction
requires **Verify / update**. A historical digest cannot be reconstructed from
dates and counts. The publisher must retain immutable exports for exact repair to
succeed; a digest query parameter detects replacement content but cannot recover
an export the publisher no longer serves.

Cache-only inspection never deletes a file. Acquisition may remove confirmed
invalid content, but temporary read/decoding-resource failures keep the stored copy.
All Blob hashing uses the shared verifier: 1 MiB chunks with at most two concurrent verifications
per page/worker, avoiding a second book-sized ArrayBuffer. A locally bundled
WebAssembly SHA-256 implementation accelerates these checks, with a portable
JavaScript fallback when WebAssembly cannot initialize. Concurrent or repeated
verification of the same immutable Blob shares its digest through weak references;
failed reads are retryable and each caller still checks its own expected identity.
Chart, PDF and legacy obstruction gzip caches share the same receipt validation.
Receipts are trusted only from Cache Storage, never from network response headers.
Obstructions now persist a versioned, filtered numeric index instead of the gzip;
each read verifies its checksum and source identity. Legacy gzip entries migrate
only after the replacement is saved. The [obstruction storage contract](../../src/layers/obstructions/README.md#source-and-lifecycle)
owns the format, validation and recovery rules.

Region records also retain their applicable Chart Supplement airport/page targets
and book identities. Refreshing the national index cannot redirect a saved airport
to an undownloaded replacement book. Existing selections capture these targets from
the matching cached index before it is refreshed; unavailable or mismatched legacy
metadata remains unverified until **Verify / update** supplies a complete plan.

### Transfers and removal

StorageManager supplies usage/quota estimates and requests persistence after an
explicit save action. A refusal is visible and does not disable best-effort caching.

Web Locks serialize download/removal operations across windows. Removal requires
a fully readable inventory under that lock; an unreadable record blocks file deletion
and selection removal because it may own shared files. Charts transfer
with bounded concurrency, and large PDF books transfer one at a time. Pause stops
new scheduling after active whole-file transfers finish. Preparation and verification
can be paused without waiting for a pending reference check; cancelled checks cannot
update or activate a resumed selection. The initial **Checking files** phase finds
reusable files before transfer. After transfer, **Final check** reports the number
of file receipts checked, then confirms reference data and commits the selection.
It checks offline availability without downloading files or hashing their bytes again.
A failed final check reports an actionable error instead of silently showing Paused.
Pausing skips the remaining check. Retry skips verified files;
an interrupted file restarts as a whole file. Closing Settings does not cancel work.
Temporary network failures, transfer timeouts and transient HTTP errors retry the
affected file after 1, 2 and 4 seconds before showing Retry. Each attempt rechecks
the saved receipt, and Pause cancels the wait. Storage, permission and integrity
errors are reported without automatic retries. Header-only receipt checks cancel their
unused response bodies so large regions do not accumulate open file streams.
Chart reads reopen an unreadable cached file once, then try to replace it with a
verified network copy; a failed repair preserves the existing cached entry.

Removing a region deletes its exclusive chart/book files and its selection record.
Files used by another saved selection, shared navigation, and the shell are retained.
An open map can fetch a removed file again if it still needs it. On-demand files not
associated with a saved selection receive the online-cache retention policy below.

An update retains the previous selection until the replacement passes verification
and its record commits. Cleanup preserves both selections' files during an incomplete
update; airport Chart Supplements use saved page targets only when their matching
books are present. The files remain shared Cache Storage objects. No second PDF copy
is introduced by the small metadata snapshots. Completed updates release the previous
selection's protection; unreferenced files can then expire or be removed explicitly.

Active/staged selection, durable availability and transfer progress are separate
concepts in the client. Existing `snapshotId`, `completedAt` and `previous` records
remain compatible; progress/error fields are never written into new selection records.
If all files arrived but activation was interrupted, the selection stays resumable
until its commit succeeds. Resume reuses those files and completes activation.

### Persistence ownership

The source separates generic Cache Storage/IndexedDB helpers in `core/storage/`
from region lifecycle in `offline/`. Plugin file acquisitions use the shared
[core transfer contract](../architecture/layer-plugins.md#file-downloads), including
streaming, scheduling and failed-file cleanup. Format validation stays with each
plugin. `offline/bundle-repository.ts` exposes
`restoreSavedBundleMetadata` for startup and a separate availability check. The
restore name includes eligible legacy adoption: committed records need no writes or
dependency reads, while older records must prove their original edition before adoption.
URL-only plan restoration, legacy bundle matching/commit, and supplement preservation
live in `offline/compatibility/`, reachable only through their persistence entry points.
Adoption keeps the existing download lock and compares the current record before
writing, so another window's update is preserved. Cache namespaces, record formats
and retention rules remain compatible with existing saves.

Explicit chart saves restore a missing cache entry from a worker's already verified
Blob when one is available. IndexedDB reconnects after an unexpected connection close.
Failed FAA-cycle switches keep the working workspace and cycle controls visible.

Cache Storage is the portable large-object store for this access pattern. OPFS would
not grant an additional quota, bypass eviction, or make background downloads reliable;
it is not necessary to copy immutable whole-file objects into another storage system.
IndexedDB contains metadata, not a second copy of those large blobs.

Older URL-only selections recover reference expectations from same-cycle cached
catalogs with matching URLs. If those expectations cannot be recovered, the selection
stays incomplete/resumable and its chart/PDF bytes are kept. Reload feeds and use
**Verify / update** to adopt the current complete plan; already verified files are reused.

### Platform limits

Target modern desktop/Android Chrome and Safari/iOS 18+ (including installed Home
Screen PWAs). The viewer and PDF worker both use PDF.js's bundled compatibility build;
see [Mozilla's browser support notes](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported).
On iOS, install first and download inside that installed app. Home Screen web apps
have storage separate from Safari tabs and are exempt from Safari's inactivity cleanup
([WebKit's tracking-prevention policy](https://webkit.org/tracking-prevention/#home-screen-web-application-domain-exempt-from-itp)).
On Android, downloads work in Chrome; installing ZLayer from Chrome's menu is optional
and can help Chrome grant persistent storage
([Chrome's persistence criteria](https://web.dev/articles/persistent-storage#chrome_and_other_chromium-based_browsers)). On all platforms,
keep ZLayer in the foreground while downloading; reopen it and select **Resume**
after suspension or termination.
No Background Fetch/Background Sync dependency is assumed. Test actual devices before
release: desktop mobile emulation does not test WebKit, memory pressure, or iOS eviction.

Persistence is a retention request, not reserved disk space. Quotas are estimates and
can exceed free device space. Quota/write failures leave the job incomplete and
retryable; no “Saved” claim is made for files that only reached memory. Browser/user
site-data deletion can still erase everything. Storage is scoped to the app's origin:
downloads on localhost or another hostname do not migrate to `zlayer.tedyin.com`.

References: [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/),
[PWA offline data](https://web.dev/learn/pwa/offline-data), and
[browser storage limits](https://web.dev/articles/storage-for-the-web).

## Offline launch and scope

### Shell and source failures

The production build embeds a content-versioned shell inventory into `sw.js`, including
the shell's Settings code, lazy map and PDF viewer chunks, workers, WASM, fonts and icons. Installation
validates the page's release, precaches the assets atomically, then saves the page
as the completion marker. Recovery validates that marker before reporting
readiness; navigation alone never creates it. An incomplete update does not
replace a working shell. Older shells are retained while multiple app windows
are open. A sole window identifies its entry module so the worker can retain that
release and the installed release, then remove obsolete shells without breaking
pending lazy imports.
Chart/PDF storage namespaces do not change with shell releases.

The last validated catalog appears before network revalidation. Cached products remain
usable when another feed, an uncached chart, or a weather request fails. Warnings are
non-blocking. Offline still needs a successful first online installation and saved
data; opening an entirely new area cannot manufacture coverage.

When the browser reports offline, the offline banner covers expected map/chart fetch
failures. If connectivity detection still reports online, **Dismiss warning** silences
subsequent fetch warnings across tiles and chart archives until the app is reloaded,
including after reconnecting. Storage, integrity and rendering failures remain visible
and can be dismissed individually.

Regional saves include published elevation terrain; they do **not** bulk-download
the background basemap or promise current weather.
Basemap resources are retained as viewed; missing ones do not disable saved chart
overlays. Weather keeps its observation times and stale/unavailable labels. Downloads
show their FAA cycle; saved means retained, not current or suitable for navigation.
Map-label identifier glyphs are bundled in the application shell. See
[deployment readiness](../development/deployment.md) for the required data-hosting setup.

### Browsing and saved editions

Route drafts and waypoint pins survive restarts. **Latest** is the default FAA cycle
mode: online launches discover the newest supported published edition. An explicitly
selected date stays pinned, including existing saved selections from older releases.
Choose **Latest** again to resume automatic selection. Offline launches use saved
catalogs and the last validated date list, with a notice when the list cannot refresh.
Saved catalogs from older releases are discovered without migration.

The global date selects the **browsing edition** and the edition for new downloads.
Completed regional selections override it both online and offline. Charts, airport
features, details and badges use the same state-boundary ownership masks. Extra
neighboring bytes acquired by conservative download envelopes do not override the
neighboring state's edition. Overlapping saved coverage (including multiple editions
of one state) prefers the newest saved effective date, then publisher build timestamp
and completion time. Different states can therefore display different
saved dates without introducing date controls on every layer. The map badge lists only
saved editions contributing coverage to the current view and disappears outside saved
regions. Automatically cached browsing data does not count as an explicit save. Airport
details show the edition used for their plates and reference data.

### Navigation, open details and recovery

Navigation loads each distinct export independently and returns usable features plus
region/product/edition failures. Failed saved regions retain ownership and show a gap;
they never borrow a different edition from browsing or another region. An unavailable
browsing export does not prevent healthy regions from loading. Outside saved regions,
the existing offline fallback may use the newest readable saved national export and
identifies its date in the notice. Composed features carry an explicit source key
through search, weather enrichment and MapLibre serialization; their plates use that
source even outside saved coverage. A retired source is reported as unavailable rather
than silently selecting the browsing edition. Opening a card captures its hydrated
feature and workspace read context together. Later activation changes new selections;
the open card keeps its navigation details, TPP catalog and supplement page targets.
Hydration matches feature ID, source identity and edition. Live weather remains free
to refresh, and the selected catalog/files are retained for routine cache cleanup
until the card closes. Partial compositions are not cached as complete:
reconnect, inventory repair and subsequent searches retry missing sources while
reusing successful source requests. Inventory changes propagate within and between tabs;
returning focus alone does not reload saved regions or navigation layers.
Map notices are contextual to visible regions;
search reports partial results without discarding healthy matches.

### Routing and restoration

Routing uses the newest saved national reference export as one coherent graph; it does
not splice airway graphs across regions. The map identifies that route-data edition.
The workspace carries browsing, regional and routing sources explicitly. Selection
identity includes both the shared catalog and the region's file/reference dependencies,
so a same-catalog supplement update refreshes readers. Availability is independent of
that identity. Startup opens committed selection metadata before background health
checks; legacy adoption still requires complete verification before claiming ownership.
Restoration returns healthy bundles and per-record issues separately. A failed legacy
cache read or unreadable record cannot discard another region's committed metadata.
Failed refreshes retain previously known ownership; a successful inventory read that
shows removal releases it. Availability errors also stay attached to the affected region.

### Updates and repair

Activation occurs only after complete verification. Staging or failing an update keeps
the previous snapshot authoritative. Later browser eviction does not change an activated
edition: missing files produce a repair notice and readers retain their exact dated
identities. Legacy selections are adopted only when their files and reference versions
match recoverable catalog metadata; otherwise their bytes remain available for repair.

Switching the browsing date does not update, remove, or cancel saved regional downloads.
Region IDs include the dated package root; file/cache keys include the full dated URL
and content identity. The same state can be saved independently for several dates,
even when archive IDs, filenames, or hashes repeat. Settings shows every saved date.
Resume and Retry keep the saved full plan, including its exact reference identities
and books, even if the publisher has replaced data within that cycle. **Verify / update**
selects a refreshed plan only for that exact region ID and date. Removing one
edition protects files referenced by any other saved region/date. Download the new
date explicitly before relying on it offline; a saved older state does not make a
new edition of that state available offline.
Settings can remove unsaved chart/PDF copies while keeping every saved region's files.
Region removal and temporary-file cleanup use the shared core confirmation dialog.
The region prompt identifies its name and FAA cycle. Cancel receives initial focus;
Cancel or Escape returns to Settings without deleting files. Removal starts only
after choosing **Remove**, with progress and errors shown in Settings.
Route-corridor downloads and automatic cycle migration remain separate future work.

### Full local reset

Settings → **Advanced** is collapsed each time Settings opens. Type `DELETE` to enable
**Delete all local data**. This removes every ZLayer cache (including old app shells),
the offline database (including region/catalog records and AHRS recordings), weather,
route draft, saved map view, panel state, first-visit acknowledgement and
preferences. It unregisters the app's service worker. Browser permissions and the
installed home-screen icon remain browser-managed.

The reset first navigates open workspaces to an isolated reset screen. Workspace
locks, reset-screen acknowledgements and service-worker write tracking prevent
background downloads or page persistence from recreating deleted data. Resident
chart blobs are discarded too, so reviving the worker cannot restore old bytes. A durable
marker keeps the workspace stopped if deletion fails; the reset can be retried.
Another window that cannot stop safely blocks deletion and must be closed. Reset
works offline, but reopening the app and restoring offline coverage requires a
connection and new downloads. Other applications' named storage is left alone.

## Automatic online-cache expiry

The 14-day rule is ZLayer's temporary browsing-cache policy, not a browser storage
limit or an expiration date for region downloads. It runs regardless of whether
persistent storage has been granted. Browser persistence protects against browser
eviction; it does not disable ZLayer's own cleanup, add disk space, or prevent the
user from deleting site data. Settings explains protection in terms of keeping
downloads available offline, with device setup guidance before the request. Pending,
granted, declined and unsupported requests have distinct messages; downloads remain
available without protection. Once protection is granted, the introductory warning
and request button are replaced by confirmation and a reminder about manual deletion.
iPhone/iPad guidance stays visible because Safari and Home Screen downloads are
separate. Temporary-file cleanup and capacity details are expandable; the cleanup
explanation identifies which files are kept and when an internet connection is needed.

After a successful online catalog refresh, an opportunistic sweep runs at most once
per day. FAA charts, PDFs and reference JSON that have been unused for **14 days** can
expire when no selection or open view references them. Existing entries without access
timestamps receive a full initial grace period. Viewing data refreshes its access time;
checking download completeness does not.

The sweep protects all saved dates, paused downloads, staged updates and previous
snapshots retained for rollback. It also protects the browsing catalogs in open tabs
and PDFs open in a viewer. Live Web Locks track those views and release automatically
if a tab crashes. Cleanup shares the regional-download lock, defers during transfers
or offline operation, and fails closed if retention records cannot be read. It leaves
the shell, weather and viewed basemap caches to their own retention policies.

## Release checks

Use a production build, not Vite's development module graph. Serve over HTTPS (localhost
is permitted for testing). Serve `.js` **and `.mjs`** as JavaScript, `.wasm` as
`application/wasm`, and manifests as `application/manifest+json`. Chart-host CORS must
permit readable GET/HEAD responses. Do not rewrite missing asset requests to HTML.
Revalidate `index.html` and `sw.js`; hashed assets may be served as immutable. Publish
the complete asset set before exposing a new shell, and retain previous hashed assets
for clients finishing an update.

1. In a clean profile, load once, open Settings, and save a small region with books.
   Do not open the PDF viewer before going offline: its first lazy load must work too.
2. Disable network, close/reopen or reload the app, then search an airport in that region.
   Pan/zoom saved VFR and IFR coverage, edit a route, and render a plate and CS page.
   Check that uncached areas warn without breaking search, route editing or saved charts.
3. Interrupt a different download, reload, then retry online. Previously verified files
   must not transfer again. Check pause/resume, failed HTTP responses, quota refusal,
   and another-window lock contention. Deleting a saved file must remove “Saved” after
   **Check saved files** and resume must replace only missing data.
4. Save overlapping regions and remove one: the remaining selection must still work.
   Refresh a Chart Supplement within the same FAA cycle without downloading its new
   book. The saved airport must keep opening its previous PDF/page offline. Fail an
   explicit update, restart offline, and verify that the previous book remains usable;
   retry online and verify the new book after another offline restart.
5. Install a new shell release with an older tab open. Both tabs must retain lazy
   viewer access. Check desktop and narrow-screen layout and keyboard dialog dismissal.
6. Repeat airplane-mode cold launch on installed iPhone/iPad and Android apps, including
   a large mainland book, process termination, and low-storage handling. Do not treat a
   desktop headless pass as device certification. Repeat the reported KVGT download
   past 177 MiB, render the chart, and reopen it offline; record device/iOS version
   and overlapping map, terrain, plate and AHRS activity.
7. In a disposable test profile, save a region, route and AHRS recording, then reset
   with another app window open and the network disabled. Both windows must stop;
   app storage and worker registrations must clear. Inject a deletion failure and
   verify retry completes without reopening the workspace. Reconnect, reopen the app
   and confirm a fresh installation can cache its shell for another offline launch.

Automated tests cover queue recovery, durable completion, overlapping-file removal,
PDF concurrency, content identities and region/book planning. The desktop Chrome
smoke test additionally exercises the built shell, native Cache Storage/IndexedDB,
saved navigation, map imagery and PDF.js without a reachable origin.

Run the committed synthetic-data regression with `npm run test:browser` after
`npx playwright install chromium`. It builds into a temporary directory and needs
no real FAA feed or external service. On systems using an existing Chrome install,
set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to that executable. The suite is also run
by `.github/workflows/verify.yml`; traces are retained for failures.
