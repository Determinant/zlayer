# ADR 0005: Make committed snapshots authoritative for offline reads

- Status: client lifecycle implemented within existing storage formats;
  publisher and storage-record redesign remain proposed
- Date: 2026-09-17
- Scope: ZLayer's offline data lifecycle and its boundary with product readers

## Diagnosis

Implementation note: regional downloads capture shared immutable catalog snapshots
and activate them after verification. The client now separates selection, availability
and transfer progress; carries an explicit workspace read context; loads committed
metadata before background health checks; and shares non-destructive artifact inspection
and bounded integrity verification. Preparation captures validated reference JSON
digests in saved snapshots and cache URLs; every saved read validates those identities.
Legacy references without digests remain cache-only until explicitly updated.
Legacy CS preservation lives at the persistence
boundary. Existing `previous` records and cache namespaces remain compatible. See
[offline storage](../offline-storage.md) for current selection and retention rules.
The proposed publisher format and separate on-disk artifact/selection records below
remain future work. The diagnosis describes the code before these client changes.

The recurrent failures had two shared causes: readers did not consistently use the
same metadata that downloads verified, and each product defined its own storage and
verification behavior. Cache Storage and IndexedDB remained suitable building blocks.

`use-catalog.ts` refreshed the workspace catalog independently of saved region plans.
`RegionDownloads` verified those plans, but TPP and chart readers followed the workspace
catalog. A region could therefore pass verification while its reader requested a new,
unsaved artifact. An FAA cycle identifies an effective interval, not a unique build.

The Chart Supplement snapshots and `previous` plan field partially implemented
activation semantics. However, the supplement loader had to inspect and migrate
region records before refreshing an index, putting package-management responsibility
inside a product loader. Extending that pattern separately to TPPs and navigation
would have multiplied coordination rules and left inconsistent read contexts.

There was a second boundary problem. PDF loading combined reading, downloading,
whole-file hashing, writing, legacy migration and deletion. Charts and reference JSON
implemented different versions of the same lifecycle. A temporary allocation failure
could look like corrupt content, and memory limits depended on which caller requested
a file. A serial regional PDF queue did not constrain simultaneous viewing.

[ADR 0004](0004-offline-packages-and-procedure-documents.md) already calls for staged
and activated packages. This proposal makes that distinction authoritative for reads.

## Proposed model

Use three explicit records, with small metadata in IndexedDB and shared whole-file
objects in Cache Storage:

| Record | Meaning |
| --- | --- |
| Artifact | One exact file or metadata document, its identity, source, verification provenance and storage location. |
| Snapshot | An immutable set of metadata and artifact references sufficient to resolve a saved selection. Includes coverage, product effective intervals and schema compatibility. |
| Region selection | References an active snapshot and, optionally, a separate staged update. Download progress and current availability are derived observations. |

Metadata belongs in the snapshot dependency set. It must be recoverable by immutable
identity, not only a mutable source URL. Shared national indexes can be stored once
and referenced by several snapshots; large JSON documents should not be copied into
every region record. Small derived regional indexes are allowed when useful, but the
same snapshot rules apply to every product.

Keep FAA effective dates, publisher build identities, and application-shell releases
distinct. A snapshot records the precise combination of product editions it uses;
Chart Supplements may have their own effective interval. Locally calculated receipts
for individual FAA PDFs remain explicitly different from publisher-provided checksums.

### Discovery and reading

Discovery records what is available remotely. It can advertise an update without
changing the bindings used by a saved selection.

A shared resolver supplies an immutable read context to charts, navigation, route
queries, and plates. Readers follow references from that context and do not search
download records or fetch a newer catalog to reinterpret an existing reference.
Once an airport or route query is resolved, its dependent lookups keep that context.

The global FAA cycle is the browsing default and the date for new downloads.
Committed regional snapshots override that default online and offline. All regional
readers share geographic ownership masks; download envelopes only select archive
files. Overlaps prefer the newest committed effective date, then publisher build and
completion time. A staged update is never a candidate. Regional read failures retain
that ownership and return partial availability rather than selecting a different date.
Routing continues to use the newest saved national export as one coherent graph.
Existing read contexts stay pinned while an update activates, and another region's
retained context remains usable.

Outside saved coverage, online browsing may use a discovered snapshot and acquire
objects on demand. That does not create a saved-region claim. New FAA cycles remain
explicit, separate selections. Discovery of a new cycle must not silently substitute
its artifacts into an operation using an older cycle.

### Stage, verify, activate

1. Persist a staged selection and its dependency references before transferring files.
2. Reuse matching stored objects and acquire missing objects through the artifact store.
3. Verify metadata compatibility and complete storage of every required dependency.
4. Atomically replace the active snapshot reference and clear the staged reference in
   one IndexedDB transaction. The previous active snapshot serves readers until then.
5. Collect unreferenced objects separately, preserving roots from all active selections,
   staged selections, and read contexts still in use.

Cache Storage and IndexedDB do not share a transaction. Write and verify objects first,
then commit the small activation record. A crash before activation leaves the old
selection usable and staged objects resumable. An object left without a reference is
recoverable cleanup work, not a reason to activate incomplete data. Local cleanup and
activation must coordinate so cleanup cannot race the commit.

Browser eviction remains possible outside application coordination. A committed
snapshot with missing files becomes degraded; its remaining readable files remain
usable. Repair requests the same artifact identities. An explicit update stages a new
snapshot. Neither operation should silently reinterpret an old reference using new data.

### Artifact storage and verification

Provide one storage contract used by both the page and worker adapters:

- Reading stored content does not implicitly delete it.
- Acquisition and repair own writes; cleanup owns removal of unreferenced objects.
- Distinguish missing content, confirmed invalid content, temporary read/resource
  failure, network failure, and storage-write failure.
- A failed read or decoder initialization does not establish that stored bytes are bad.
- Verification receipts identify the exact stored object and validation policy;
  availability checks and content verification are separate operations.
- Use incremental hashing with bounded chunks for new and cached large files. Avoid a
  book-sized JavaScript ArrayBuffer. Preserve the existing requirement to validate
  content before rendering, using the same bounded verification path on reuse.
- Coalesce by artifact identity. Bound verification and acquisition across both
  on-demand viewing and explicit downloads, including cooperating app windows.
- Cancel obsolete queued work. Once a shared whole-file transfer starts, closing one
  viewer must not cancel it while another reader or staged selection still needs it.

This is shared policy and a small storage API, not a requirement that all work execute
inside one service worker. Durable state must remain sufficient to recover when any
worker or page disappears. Product modules retain their schema guards, PDF page logic,
SQLite decoding, and rendering. JavaScript buffer bounds also need device measurement;
they do not bound the browser's own storage and rendering allocations.

## Publisher boundary

Content identity and download location are different. Appending a checksum or export
timestamp to a mutable URL lets a client reject mismatched bytes; it does not make an
older export retrievable from the server.

The client can capture validated metadata under immutable local identities now. The
publisher should ultimately expose immutable metadata/artifact versions and a release
descriptor naming their exact identities, published after its dependencies. Retention
of previous objects determines whether an evicted old artifact can be downloaded again.
If the publisher no longer serves it, report that limitation and preserve other saved
content; never substitute a different edition while claiming to repair the old one.

The existing dated product publishers can be adapted incrementally. A new backend or
storage technology is not required to establish the client snapshot boundary.

## Implementation sequence

1. Define snapshot, selection, read-context and artifact-result contracts. Add lifecycle
   tests covering the same-cycle refresh, transient read failure and interrupted commit.
2. Introduce an artifact-store adapter over current cache entries. Centralize failure
   classification and bounded verification without moving or duplicating saved books.
3. Introduce active/staged selection records and immutable metadata references. Migrate
   validated legacy plans conservatively; incomplete or ambiguous records stay repairable.
4. Route every saved-data consumer through the resolver. Replace the CS-specific
   snapshot/migration path and nested `previous` behavior with the common lifecycle.
5. Align publisher metadata identities and retention, then make WebKit and mobile
   lifecycle verification repeatable in the test workflow.

The end state should remove special cases, not leave a second offline system alongside
the first. Existing cache namespaces, shared whole-file MBTiles/PDF storage, product
renderers, and shell precaching remain useful. The work is concentrated in data
resolution, offline orchestration, storage adapters, and their callers.

## Acceptance criteria

- Discovering or staging a same-cycle replacement never changes existing saved reads.
- Charts, TPPs, supplements and navigation obey the same snapshot-selection rules.
- Failed updates and crashes at each activation boundary leave the old snapshot usable.
- Availability checks never assert that a different snapshot's objects satisfy a save.
- Temporary read/hash/worker failures preserve stored objects and are retryable.
- A representative large book incurs bounded application verification buffers.
- Overlapping regions, multiple windows and cleanup preserve every required object.
- Missing objects degrade availability and repair by exact identity; a new export is
  treated as an update, not an unnoticed repair.
- Existing saves migrate without redownloading verified large files when their metadata
  can be recovered reliably.
- Production-shell tests run against Chromium and WebKit, followed by physical iPad
  and Android checks for installed launch, suspension, process termination and pressure.
