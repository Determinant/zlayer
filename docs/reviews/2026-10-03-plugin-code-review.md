# Sequential plugin code review

[Documentation](../README.md) / [Reviews](README.md)

Reviewed: 2026-10-03. **All 12 plugins reviewed; all six confirmed findings and
five follow-up integration gaps implemented.** All 17 cleanup recommendations have
a disposition below. The implementation is included in the commit introducing this review.
Tests, browser/device checks and full verify have not been run; implementation
completion is not a claim of runtime verification or absence of regressions.

Source baseline: `9834c102e30097aab71296be586b7b3e179cbce1`.
The per-plugin evidence, line numbers and recommendations after “Coverage and
findings” describe that baseline and retain the original rationale. The status
and decision tables here supersede those historical recommendations as a worklist.
No confirmed implementation defect from this review remains open on static inspection.

Method: source/caller/lifecycle inspection, regression-source review, TypeScript
and import-boundary checks. The original review ran no code. The implementation
follow-up also ran the small, synthetic CPU/memory probe documented below; it did
not run tests, builds, browser sessions or full verify. Changes preserve acquisition,
persistence, source identity, ordinary interaction and estimator policies except
for the explicitly identified display/recovery corrections.

## Implementation status

| Finding | Resolution | Regression source / verification boundary |
| --- | --- | --- |
| RUL-001 | Bounded projected-error subdivision at zoom 13; endpoint-only reuse and dateline continuity retained. The 0.5 px target can be exceeded at depth/vertex caps. | Independent projected-error/edge-case cases added; close/high-latitude visual checks unexecuted. |
| RUL-002 | Gesture claim requires renderer attachment; disposal releases it, intent survives remount and controls reflect availability. | Attachment/lifecycle cases updated; browser lazy-load failure unexecuted. |
| RUL-003 | Workspace mutation/resize/transition observation refreshes occupied rectangles while Ruler is open, coalesced to a frame. | Overlay-movement browser case added; physical touch layouts unexecuted. |
| RUL-004 | Affected adapters use the existing acceptance helper with local visibility, status, bounded retry and stale-completion guards. All five follow-up gaps below are corrected. | Failure/clear/recovery/detach cases added or extended; real MapLibre worker-failure checks unexecuted. |
| OWN-001 | Motion admission, continuity and filtering use normalized acquisition seconds; core GPS policy and raw timestamps remain unchanged. | Normalized-time motion cases added; display continuity unexecuted. |
| PLA-001 | Ctrl/Meta-wheel shares anchored bitmap preview and commits after 150 ms idle, retaining existing bounds and ordinary scrolling. | Successive-frame wheel case observes anchors and detached render-buffer creation, including cancelled renders; browser/Safari runs unexecuted. |

The adapters retain prepared geometry or stable inputs, schedule one automatic
100 ms retry per update, and allow later camera/input demand to retry. They do not
add a shared retry engine. METAR and cached Terrain corridors keep their initial
`addSource` upload without a duplicate `setData`. Routes retains the expected
preview-feature readiness guard before hiding the original leg. Landing vectors
acknowledge their render key only after source acceptance. Acceptance is not a
claim that replacement tiles have already reached the screen.

### Follow-up integration audit — resolved

The intermediate implementation and commit-readiness audits reopened RUL-004. These five
gaps are retained here as rationale, not erased or counted as new baseline defects.

| Gap in the intermediate implementation | Completed correction |
| --- | --- |
| Navigation inspection was omitted; failed selection/clear could leave old coordinates with a new label. | Inspection has acceptance, immediate clear/failure hiding, bounded retry and detach invalidation. Its formatted label now travels inside the selected feature, preserving coordinate/label pairing through tile processing. |
| METAR repeated callbacks could reveal old colors while an empty/disabled update was pending. | Suppression stays latched until the current upload is accepted. Accepted empty data stays hidden; accepted category-disabled points may render gray. Freshness/acquisition remain separate. |
| Obstructions accepted an old buffer and marked a newly panned viewport ready while its refill was running. | Acceptance reconciles through existing viewport coverage/demand logic. A current refill stays loading; warm-buffer recovery avoids another query. |
| Glide discarded animation acceptance booleans and could retry intermediate frames. | Failed interpolation stops, invalidates the peer upload and retains the exact complete target for recovery. The peer cannot resubmit an obsolete frame after a synchronous error. |
| Landing vectors could lose the current render-key receipt when a retry succeeded before the failed upload settled, then restore an error after recovery. | The prepared receipt is retained before awaiting acceptance. A successful retry acknowledges that receipt, and the obsolete failed completion cannot overwrite its status. A regression source covers receipt replacement, completion ordering and detach. |

### Disposition of every cleanup recommendation

“Preserved” or “no additional change” is an assessed decision, not deferred
implementation. Conditional optimizations were not converted into requirements
without evidence. Physical-device measurements remain a validation limitation.

| Recommendation | Final disposition |
| --- | --- |
| REC-RUL-01 | Implemented: existing acceptance helper, explicit attachment state and existing state/geometry/renderer ownership. |
| REC-OWN-01 | Implemented: independent `LayerScope` disposers for GPS demand, subscriptions, frames, listeners and map resources; cleanup-error regression added. |
| REC-OWN-02 | Implemented: local history-reset helper; bounded arrays retained. |
| REC-OWN-03 | Implemented: guide distinguishes retained position from rejected velocity; GPS policy unchanged. |
| REC-OBS-01 | Implemented: local source recovery and viewport reconciliation; worker/index/query ownership preserved. |
| REC-NAV-01 | Implemented: main, priority and inspection source acceptance. No arbitrary cache-byte eviction added: this review establishes no measured national-collection retention problem, and identity/coverage reuse remains valuable. |
| REC-MET-01 | Implemented: pending suppression and acceptance; freshness remains independent and METAR/TAF clients remain separate. |
| REC-PLA-01 | Implemented: shared anchored gesture path; PDF ownership/serialization preserved, cross-frame regression strengthened. |
| REC-CHA-01 | Implemented: scoped listener/resource/reader disposal and replaceable catalog resource scope; publisher and whole-file strategy preserved. |
| REC-TER-01 | Measured and implemented: aggregate synthetic retention exposed dense vectors; added a 32 MiB estimated offscreen-vector budget alongside 128 entries, pinning visible coverage. Existing worker/unknown-cell policies retained. |
| REC-GLI-01 | Measured and implemented: worker omits an airport plan only after both map sources accept its generation/revision key. Failure, clear and worker replacement revoke acknowledgment; metadata and origin results continue. |
| REC-GLI-02 | Implemented: source acceptance propagates into animation; complete targets survive failure. Computation, landing acquisition and map acceptance keep separate owners. |
| REC-ROU-01 | Implemented: per-source acceptance and independent scoped cleanup; cheap drag source and expected-feature reveal preserved. |
| REC-AWC-01 | Implemented: independently scoped parent/child cleanup, parent updates revoked before disposal; controller/product and renderer-specific boundaries retained. |
| REC-AWC-02 | Assessed with local aggregate scalar/wind/raster and cold-preparation probes. Existing packed/transferred bands and two-bracket wind ownership retained; no repeated-copy or identity-serialization hotspot established, so no speculative rewrite. |
| REC-AHR-01 | Assessed with normal/delayed GPS CPU and retained-memory probes including estimator-owned history. No allocation or array-movement hotspot isolated; preserve matrices, event ordering, checkpoints and full IMU delivery. |
| REC-AHR-02 | Assessed: repeated unchanged-window reads measured locally. Median 0.160 ms / p95 0.254 ms does not justify adding evidence/staleness-cache complexity here. Time weighting and pause/pose semantics remain unchanged. |

### Scoped performance evidence

Reproduce with `node --expose-gc --import=tsx tools/benchmark-plugin-review.ts`.
Run on 2026-10-03, Node 24.15.0, Linux x64. Each scenario uses a fresh process and
collected baseline. These are synthetic local CPU/retention measurements, not
whole-app peaks, actual worker round-trip latency, GPU usage, download/storage
latency, target-device budgets or flight qualification. Array-buffer and heap
figures are separate; neither is total process memory.

| Scenario | Recorded result | Decision |
| --- | --- | --- |
| Terrain: 128 copies of a production-generated dense 64² contour tile, four visible, saturated 40 MiB decoded budgets plus four 512² RGBA buffers | Entry-only: 321,250,800 heap bytes. New size budget: 44,638,968 heap bytes, 17 retained tiles including all four visible. Both: 46,153,728 array-buffer bytes. | Bound offscreen vector retention. The 32 MiB estimate is not a literal heap cap; visible data can exceed it and revisiting evicted tiles can recompute vectors. |
| Glide: production planner, 12 synthetic flat-terrain airports; 40 structured clones per payload | Full 8,410 bytes / median 0.048 ms; acknowledged 3,288 bytes / median 0.014 ms. | Modest in this fixture, but omitting unchanged geometry removes the repeated cost without changing calculations. |
| AWC: 512² scalar decode/validation + raster, and two wind brackets/output/terrain held together | 2,838,080 heap + 24,647,881 array-buffer bytes; cold decode 22.96 ms, raster 12.29 ms, wind interpolation 29.02 ms. | Keep current compact bands, worker admission and bracket retention. Synthetic smooth fields compress unusually well; no network/persistence claim. |
| AHRS: 12 simulated seconds at 120 Hz, GPS once/second | IMU p95 0.378 ms with current GPS, 0.405 ms with 250 ms delayed GPS. GPS median 0.520 vs 3.947 ms; delayed maximum 11.094 ms. Retained heap about 2.5 MB and array buffers about 10.7 MB in each run. | Delayed replay costs more, as expected. No numerical/history rewrite justified by this bounded desktop sample. Magnetic/flight/device tails are not measured. |
| Calibration: completed 120 Hz IMU window waiting for GPS; 1,000 unchanged reads | Median 0.160 ms, p95 0.254 ms, max 1.965 ms. | Leave diagnostics uncached; duplicate reads are small here and new sensor evidence still requires work. |

## Coverage and findings

| Order | Plugin | Review status | Confirmed baseline findings |
| --- | --- | --- | --- |
| 1 | [Ruler](../../src/layers/ruler/README.md) | Reviewed; original findings rechecked | RUL-001–004 |
| 2 | [Ownship](../../src/layers/ownship/README.md) | Reviewed | OWN-001 |
| 3 | [Obstructions](../../src/layers/obstructions/README.md) | Reviewed | RUL-004 (shared) |
| 4 | [Navigation](../../src/layers/navigation/README.md) | Reviewed | RUL-004 (shared) |
| 5 | [METAR/TAF](../../src/layers/metar-taf/README.md) | Reviewed | RUL-004 (shared) |
| 6 | [Plates](../../src/layers/plates/README.md) | Reviewed | PLA-001 |
| 7 | [Charts](../../src/layers/charts/README.md) | Reviewed | None identified |
| 8 | [Terrain](../../src/layers/terrain/README.md) | Reviewed | RUL-004 (vector sources) |
| 9 | [Glide](../../src/layers/glide/README.md) | Reviewed | RUL-004 (shared) |
| 10 | [Routes](../../src/layers/routes/README.md) | Reviewed | RUL-004 (shared) |
| 11 | [AWC Weather](../../src/layers/weather-awc/README.md) | Reviewed | None identified |
| 12 | [AHRS](../../src/layers/ahrs/README.md) | Reviewed | None identified |

P1 means a high-priority correctness or availability defect; P2 means a concrete
defect to fix in normal development; P3 means a minor defect. Recommendations
prefixed `REC-` are separate from confirmed defects and have no defect severity.
The six consolidated findings below were supported by baseline source inspection,
not runtime reproductions; their follow-up status is recorded above.
RUL-004 affects seven plugins and is counted once.
No P1 finding was identified in the reviewed scope. “None identified” means no
confirmed defect in the inspected paths, not that a plugin is certified correct.

| ID | Priority | Finding | Primary owner |
| --- | --- | --- | --- |
| RUL-001 | P2 | Coarse line sampling departs visibly from the measured great circle | Ruler measurement/renderer |
| RUL-002 | P2 | Unavailable renderer can still claim exclusive map gestures | Ruler plugin/map lifecycle |
| RUL-003 | P2 | Grip avoidance retains obsolete panel rectangles | Ruler map / workspace layout integration |
| RUL-004 | P2 | Failed source updates leave submitted geometry treated as current | Shared failure mode; individual map adapters |
| OWN-001 | P2 | Motion history and filtering use raw epoch time instead of normalized acquisition time | Ownship position/layer |
| PLA-001 | P2 | Ctrl-wheel zoom loses its gesture anchor and repeatedly requests PDF rendering | Plates viewer |

### Accuracy and practicality recheck

All six findings were supported by the rechecked baseline code. Their triggers differ:
RUL-001, RUL-003 and PLA-001 concern ordinary display/interaction paths; OWN-001
needs accepted fixes whose raw and normalized elapsed times differ; RUL-002 needs
an unavailable renderer; RUL-004 needs a source-processing failure. This review
does not establish how often those failures occur on real devices. In particular,
seven affected plugins does not mean seven routinely broken renderers.

The fixes can remain local. Source recovery should be implemented in small
plugin-specific changes using the existing helper, without a shared retry engine
or duplicate geometry caches. Scope-based disposal is optional hardening when an
adapter is already being changed, not a requirement to rewrite every teardown.
Cache-budget and AHRS optimization suggestions require measurements first.
REC-OWN-03 is documentation clarification, not authorization to change GPS policy.

## Ruler

Reviewed every file in `src/layers/ruler/`, plus the relevant store/scope/frame
helpers, magnetic model and loading hook, map contribution/host, occupied-region
provider, gesture coordination and Ruler regression sources.

### RUL-001 — Bound projected error when drawing the great circle

**Evidence:** [measurement.ts](../../src/layers/ruler/measurement.ts),
`rulerPath`, lines 38–53; [renderer.ts](../../src/layers/ruler/renderer.ts),
`draw`, lines 46–60.

`ceil(angle / RAD)` permits segments almost one angular degree long. For
`[-1, 60]` to `[1, 60]`, the central angle is just under one degree, so the function
returns only the two endpoints. The Mercator line between them stays at latitude
60°, while the actual great circle bows north. The distance and bearing readout
use the great circle, creating a mismatch with the displayed path. Zooming into
an existing measurement magnifies the error; camera changes do not regenerate
the geometry because the renderer only compares endpoint references.

**Recommendation:** subdivide using a projected-error tolerance, with explicit
work/vertex limits and antimeridian continuity. First assess whether preparing
for the map's configured maximum zoom of 13 meets the tolerance within a modest
vertex budget; that would preserve the current endpoint-only cache. If not,
cache geometry for a zoom range and refine when that range no longer meets the
tolerance. Reuse it during pans and ordinary redraws, and specify behavior at
the vertex limit.

**Future verification:** compare projected midpoints against the sampled path at
high latitude and supported close zooms; retain dateline and degenerate-endpoint
cases. A larger vertex count alone is not an acceptance criterion.

### RUL-002 — Tie gesture ownership to an attached renderer

**Evidence:** [plugin.tsx](../../src/layers/ruler/plugin.tsx), lines 16–25;
[map.ts](../../src/layers/ruler/map.ts), lines 16–21;
[workspace selection](../../src/workspace/map/selection.ts), lines 61–67.

The public `active` store reflects user state alone. The overlay remains usable
when its separate lazy renderer fails to import or mount. Opening Ruler then
sets `active = true`, causing the workspace to suppress normal feature selection
and route editing, although no ruler interaction is attached. Renderer cleanup
does not revoke this state. The user must close or disable the unavailable tool
to recover those gestures; pan/zoom are not the affected interactions.

**Recommendation:** represent renderer availability explicitly and claim gestures
only while the requested tool has a healthy attachment. Revoke that claim on
failure/detach and make unavailable controls reflect that state. Keep temporary
measurement intent separate if it must survive style replacement. Routes already
provides a local example in
[map-contribution.ts](../../src/layers/routes/map-contribution.ts), where editing
capability follows renderer lifetime.

**Future verification:** failed lazy import, partial mount failure, and remount
while Ruler is requested must leave ordinary selection available whenever Ruler
cannot handle input.

### RUL-003 — Refresh grip obstacles when overlays change

**Evidence:** [map.ts](../../src/layers/ruler/map.ts), cached `obstacles` and
`draw` at lines 47–49, refresh sites at lines 79, 90, 111 and 151, and container-only
observation at lines 179–186;
[occupied-regions.ts](../../src/workspace/map/occupied-regions.ts).

Opening/stowing an absolutely positioned edge panel, or changing the ruler
card's height, need not resize the map container. The resize observer therefore
does not refresh those rectangles. Camera movement redraws using the old cache;
once both endpoints exist, ordinary canvas pointer-down also returns before
refreshing it. A grip near a changed panel edge can remain covered even where a
different offset would be reachable, or unnecessarily avoid space a panel vacated.

**Recommendation:** add a small workspace-owned layout notification alongside
the existing rectangle provider. Connect it to relevant panel state, completed
transitions and element-size changes; observing only element size would still
miss a CSS transform. Refresh after DOM layout settles and coalesce draws. Keep
shell selectors in the workspace. This does not need a global layout service or
a DOM scan on every camera frame.

**Future verification:** place endpoints near an overlay edge, open and stow the
overlay without resizing the map, and change the ruler card's content height.
Grips should move to a reachable offset when one exists.

### RUL-004 — Invalidate visual reuse after a source failure

**Evidence:** [renderer.ts](../../src/layers/ruler/renderer.ts), lines 56–60.
The installed MapLibre 6.9.0 implementation in
`node_modules/maplibre-gl/src/source/geojson_source.ts`, `setData` and
`_dispatchWorkerUpdate`, submits asynchronously and emits source errors when
worker loading fails.

The renderer records `previousStart`/`previousEnd` immediately after calling
`setData` and never listens for source failure. If that submission fails, every
subsequent draw with the same endpoints skips submission, including pan/zoom.
The line can remain absent or show an older measurement while grips and readout
show the new endpoints. A failed empty update on Close can also leave the old
style-layer line visible after the DOM grips disappear.

**Recommendation:** invalidate visual reuse on a source error and distinguish
submitted data from accepted data. Reuse
[source-submission.ts](../../src/core/map/source-submission.ts) where appropriate,
including its error-event handling; promise completion alone does not prove
acceptance. The helper tracks revisions and failures; it does **not** schedule
retries, hide layers or establish that replacement tiles have reached the screen.
Those remain adapter responsibilities. Preserve Routes' expected-feature reveal
check and each plugin's explicit stale-data policy.

Retain existing computed data and track submission revisions/dirty state; three
separate copies of the GeoJSON are unnecessary. Use a bounded retry policy, such
as one deferred retry followed by an explicit retry or relevant demand change;
cancel it on detach or superseding input. Do not retry on every render frame or
refetch valid source files to repair map submission. Failed clears need immediate
visibility suppression so stale output cannot remain active while recovery waits.

**Future verification:** inject source failure during placement and during Close;
unchanged input must be recoverable without moving an endpoint, and teardown must
release the error subscription.

### Maintainability and computational assessment

State, pure geometry, controls and imperative rendering have clear ownership.
Session guards prevent cancelled drags from restoring replaced measurements.
`LayerScope` registers reverse-order cleanup as resources are acquired, including
partial initialization; preserve that structure.

The current path has at most 181 vertices. Grip placement scores ten candidates
per endpoint against the supplied obstacle list. Magnetic evaluation is a fixed
90-term calculation, and dragging publishes at most once per animation frame
except the deliberate immediate release commit. Camera-only changes reuse source
geometry; there is no recurring idle animation. No algorithmic performance defect
was identified, but RUL-001 needs better accuracy within a bounded work budget.

**REC-RUL-01 — Focused refactor with the fixes:** use the existing source-acceptance
helper for RUL-004 and explicit attachment state for RUL-002. Preserve plain
functions and the existing state/renderer split; a new generic interaction
framework or worker is not justified for this workload.

## Ownship

Reviewed every file in `src/layers/ownship/`, plus the shared GPS service and fix
normalizer, GPS camera and track-bearing integration, relevant host/store helpers,
installed GeoJSON source implementation, and Ownship/GPS regression sources.
The AHRS estimator and plugin receive their own review below.

### OWN-001 — Use normalized acquisition time for motion calculations

**Evidence:** [position.ts](../../src/layers/ownship/position.ts),
`estimateTurnRate` at lines 42–56 and 78, `smoothMotion` at lines 90–96;
[layer.ts](../../src/layers/ownship/layer.ts), lines 30–37.
The owning [shared GPS contract](../architecture/layer-plugins.md#shared-gps-service)
distinguishes raw epoch-millisecond `timestamp` from normalized monotonic `time`.
[core/gps/position.ts](../../src/core/gps/position.ts), lines 31–38, intentionally
accepts small future timestamps while clamping their acquisition time to receipt.

Ownship calculates sample admission, retention, continuity gaps, regression rates
and low-pass gains from `timestamp`. Those intervals need not equal the accepted
acquisition intervals. For example, two receipts one second apart, with only the
second source timestamp rounded 500 ms into the future, have normalized times
one second apart but raw timestamps 1.5 seconds apart. Both can be accepted without
core's greater-than-one-second clock-discontinuity reset. Ownship then uses the
wrong elapsed time for smoothing and turn inference, potentially changing
curvature confidence or triggering an inappropriate continuity boundary. The GPS
camera already consumes `fix.time`, so the displays can disagree about timing.

**Recommendation:** use `GpsFix.time` consistently for all motion durations and
history boundaries, with clearly named seconds-based thresholds or explicit unit
conversion. Retain `timestamp` for provenance/display. Preserve the stale boundary
that core publishes for larger clock changes and the existing sample/work bounds.

**Future verification:** give the motion path accepted fixes with identical
normalized times/tracks but differing permitted epoch rounding; inferred motion
should be identical. Retain real gap, source-change and suspension resets.

### Maintainability and computational assessment

The plugin delegates acquisition to the shared GPS service, and renderer attachment
owns its independent lease. Disabled Ownship unsubscribes rather than consuming
another plugin's GPS updates. Optional AHRS heading has revision guards and
separate camera demand. Geometry and status comparison avoid republishing visual
work for timestamp-only changes. Source errors invalidate Ownship's visual reuse
for the next fix; this is a useful contrast when addressing RUL-004.

History admission is spaced by at least 100 ms and retains ten seconds, keeping
roughly 101 observations under continuous timestamps; regression scans at most
the recent six-second window. Its passes are linear over that bounded input.
Geometry contains one aircraft point, a 49-coordinate accuracy ring and at most
31 track-vector coordinates. Multiple live updates coalesce into one frame;
stale/disabled state flushes immediately. The local-plane curved-vector model and
display lag are documented heuristics, not hidden numerical guarantees.

**REC-OWN-01 — Optional cleanup hardening when touching this adapter:**
[map.ts](../../src/layers/ownship/map.ts), lines 71–83, performs unsubscription,
source-listener removal, GPS detach, layer/source removal and image removal in
one sequential block. Although the host calls teardown after partial mount,
one thrown cleanup can skip the remaining resource releases. Register each owned
resource with `LayerScope` as it is acquired, retaining frame cancellation before
source removal and lease release even if another cleanup fails. This is a
defensive lifecycle refactor; no ordinary-path resource leak was established.

**REC-OWN-02 — Keep the motion reset policy together:** `layer.ts` repeats history
clearing and boundary resets across GPS loss, demand changes and detach. A small
local reset helper would make changes such as OWN-001 less likely to leave one
path inconsistent. Do this with the timing fix rather than introducing a separate
history abstraction, ring buffer or new state machine. The current bounded arrays
do not justify a performance rewrite.

**REC-OWN-03 — Clarify the position-jump policy before changing it:** core rejects
implausible *velocity* estimates but can retain the reported position as a live
fix, so track-up can still recenter after a provider jump. The existing
[position regression](../../test/ownship-position.test.ts), lines 294–300,
explicitly expects the jumped fix to survive with unknown velocity. This is
deliberate current behavior, not a confirmed violation of the motion bound.
Clarify that distinction in the owning guide. If position continuity gating is
desired, specify its uncertainty, reacquisition and recovery behavior in core so
Ownship and AHRS receive the same decision; do not add a silent map-only clamp.

## Obstructions

Reviewed the guide, plugin/layer lifecycle, renderer, national-index loading and
streaming validation, worker API, view coverage and route-corridor selection.

**RUL-004 also applies:** [layer.ts](../../src/layers/obstructions/layer.ts)
publishes the collection and records warm query coverage independently of
MapLibre acceptance; [renderer.ts](../../src/layers/obstructions/renderer.ts)
submits without source-error invalidation. A failed update can leave old or absent
obstructions while status reports the new count. A camera move within warm
coverage does not requery or resubmit. Keep the validated index and warm coverage;
recover the visual submission from the retained collection. Do not reload the
national feed just to repair a renderer error.

The worker validates source length, digest, count and duplicate IDs before
adopting a national index. Parsing bounds each streamed record; numeric records
and a zoom-7 spatial index keep query work away from the full national collection.
Padded coverage, an 80 ms throttle and one active query plus one latest request
avoid repeated preparation during pans. Route revisions discard obsolete results;
failed refreshes retain previously validated data. Derived persistence is bounded
to four files/32 MiB, with an 8 MiB per-file limit; oversized live indexes are not
misrepresented as saved snapshots. No additional correctness defect was established.

**REC-OBS-01:** preserve the simple query loop and immutable source identity.
Apply the source-submission fix locally; do not add a second index/cache or a
general scheduler for this already bounded path.

## Navigation

Reviewed the guide and fix-display design, catalog/data API and cache identity,
map layer and main source synchronization, fix ranking, search and data hooks,
identification overlay, waypoint inspection, navaid Morse and airport-frequency
helpers. This pass traces the data and lifecycle boundaries; it does not claim
pixel-level verification of all detail components.

**RUL-004 also applies:** [layer.ts](../../src/layers/navigation/layer.ts)
retains `displayed` collections before acceptance, and
[renderer.ts](../../src/layers/navigation/renderer.ts), `syncNavigationData`,
skips identical collection references without invalidating them on source error.
A failed airport/navaid/fix submission can remain absent or stale until a new
collection or remount. Visibility toggling alone cannot establish acceptance.
Include priority/inspection source reuse in the same focused audit.

The [identification layer](../../src/layers/navigation/identification-layer.ts)
already uses the shared source-submission helper with pending/dirty work and
failure invalidation. Preserve that working path instead of replacing it.

Full source identity includes revision, URL, digest/size/count, regional ownership,
chart bounds and cache-only mode. Failed or partial composition is not retained
as a complete cached view. National fix ranking is reused per immutable collection;
the initial sort is O(n log n), followed by fixed display tiers and world-cell
selection. Search debounces requests and enriches only its bounded matches with
weather. No per-camera national sort or separate confirmed performance defect was
found. The 24-entry view cache bounds entry count, not retained bytes.

**REC-NAV-01:** align the main sources with identification's existing acceptance
handling. If memory profiling shows pressure from multiple large catalog views,
add a measured byte budget to the current cache; a new cache abstraction is not
justified by entry count alone.

## METAR/TAF

Reviewed the guide, METAR/TAF clients, station and area request handling, cache and
freshness rules, METAR map demand/rendering, airport weather state, nearby reports,
TAF summary/report selection and runway-wind helpers. Domain-wide weather parsing
is a dependency of this pass, not a new meteorological validation campaign.

**RUL-004 also applies:** [metar/layer.ts](../../src/layers/metar-taf/metar/layer.ts)
records `display` immediately after
[renderer.ts](../../src/layers/metar-taf/metar/renderer.ts) submits the map data.
There is no source-error invalidation. When later checks retain the same report
objects, successful fetches and the freshness timer can continue skipping the
failed visual update. Track acceptance separately so the displayed flight-category
source can recover even when report content is unchanged.

METAR retains at most 5,000 stations and 200 area entries; TAF retains 200 of each.
METAR station batches hold at most 100 IDs with two active requests, deduplicate
shared demand and release individual cancelled consumers. Area results publish
after all antimeridian boxes complete. Original checked-at metadata survives
cached responses, preventing a cache read from becoming a false fresh network
check. Camera/visibility/online demand and cancellation keep irrelevant map work
bounded. No additional confirmed defect was identified in these paths.

**REC-MET-01:** keep cache freshness and renderer acceptance as separate states.
Do not merge METAR and TAF clients merely because both cache weather: their batch,
coverage and response semantics differ. Extract only identical, tested mechanics
when a concrete maintenance need appears.

## Plates

Reviewed the guide, viewer and gestures, PDF sessions/rendering, document cache,
map-image preparation/georeferencing, controller/restore/persistence, supplements
and offline planning. Read the relevant existing gesture regression source.

### PLA-001 — Give Ctrl-wheel zoom the same anchored preview lifecycle

**Evidence:** [viewer.tsx](../../src/layers/plates/viewer.tsx), lines 130–143;
[use-pdf-viewer.ts](../../src/layers/plates/use-pdf-viewer.ts), lines 71–137;
[use-pinch-zoom.ts](../../src/layers/plates/use-pinch-zoom.ts).

The guide promises anchored bitmap preview for both touch and trackpad gestures,
followed by a PDF redraw after release. Touch and Safari gesture events implement
that policy. The Ctrl/Meta-wheel path only changes zoom; it never uses the event
position to preserve the point under the gesture or enters the `pinching` state.
Consequently the page scales without the required anchor, and wheel events
committed in successive frames can each cancel/start a PDF render instead of
previewing the bitmap through the gesture. Render serialization bounds simultaneous
buffers but does not eliminate that repeated work.

**Recommendation:** route wheel gestures through the existing anchor/preview
mechanism. Capture the pointer position, preview scaling and adjust scroll around
it, then commit one sharp render after a short gesture-idle interval. Clear that
interval on selection changes and unmount. Preserve browser-zoom prevention and
the 50–400% bounds.

**Future verification:** a series of Ctrl-wheel events away from the canvas origin
must hold the page coordinate under the pointer and defer the final PDF render
until the gesture settles. Existing prevention/zoom-change assertions alone do not
cover anchoring or render churn.

### Maintainability and computational assessment

Shared document sessions, last-reader teardown, stale selection guards and
serialized render cancellation have clear ownership. The durable-file path
distinguishes verified saved bytes from a bounded live-only fallback. Map-image
replacement waits for a complete image and frees old canvases; disposal preserves
saved intent while removing live resources. Georeferencing rejects unsupported or
inconsistent control data rather than guessing placement.

Display and temporary PDF buffers have explicit size caps. Map-image preparation
uses bounded canvases and a fixed 24×24 warp mesh; this creates many draw calls,
but this static pass cannot characterize their device cost. The affine
control-point search is bounded by the accepted control-point limit.

**REC-PLA-01:** unify the two gesture paths as part of PLA-001, retaining the current
PDF resource ownership and renderer serialization. No PDF-cache rewrite is proposed.

## Charts

Reviewed the guide, map/layer/render definitions, source keys, protocol registration,
regional composition, package index/loader/decoder, legacy MBTiles reader, reader
pool and cache-preparation hook. Shared whole-file storage is inspected through
these adapters, not exhaustively re-audited here.

No confirmed defect was identified. Source identity includes chart/archive identity
and ordered regional ownership. Regional tiles clip by ownership before drawing;
missing saved pixels do not silently reveal a different edition. Reader leases
release workers at last detach, queued opens can be cancelled, late resources are
disposed and failed readers can be replaced. Failure notifications also cover
partially drawn regional tiles, allowing recovery on reconnect/inventory change.

The fast path bounds compressed resident packages to 16, each at most 4 MiB and
64 tiles, with serialized SQLite decode. Legacy readers are separately limited
to six. Underzoom composition reads ordered batches of 16 and decodes one bitmap
at a time into a 256-pixel canvas. Total underzoom work still scales with covered
source tiles, as the guide acknowledges. None of these limits alone establishes
a total browser memory budget.

**REC-CHA-01:** keep publisher-provided low-zoom tiles as the solution for expensive
legacy overviews; do not replace whole-file acquisition with origin range/tile
requests. A future lifecycle cleanup should use the existing scope helper for
independently releasable listeners/layers/readers, while preserving the current
`finally` guarantee around reader release.

## Terrain

Reviewed the owning guide's rendering, precision, recovery and resource contracts;
layer/worker lifecycle; source selection; packaged and fallback elevation loading;
archive decoding; grid pooling/interpolation; fill/viewport encoding; point
sampling; vector cache and corridor-job ownership. This is not a new proof of all
isoline smoothing/topology code or a visual seam assessment.

**RUL-004 also applies to vectors:** [layer.ts](../../src/layers/terrain/layer.ts),
`syncVectors`, saves `published` before labels/contours are accepted. Its
`sourceError` handler updates status and repaints raster errors, but does not
invalidate that vector snapshot. A failed label/contour submission is skipped
on subsequent refreshes with the same visible tile objects. Similarly,
[corridor-job.ts](../../src/layers/terrain/corridor-job.ts) caches computed geometry
before its visual submission. Separate reusable computed geometry from accepted
map geometry. Raster tile recovery already exists and should be preserved.

The worker limits render jobs and DEM reads to four each. Decoded Mercator grids
have a 32 MiB cap, with a separate 8 MiB geographic-grid cache; vectors, temporary
grids/canvases and MapLibre textures add to those budgets. The 128-entry vector
cache intentionally retains all currently visible tiles even above that count.
Whole-file identities preserve saved-source precedence. Archive decoding bounds
inflation and validates directory layout, grid location, byte count and physical
height range. Missing contributors propagate as unknown; source maxima and
interpolated display surfaces remain distinct. Altitude updates only change
palette/labels, coalesced per frame. No additional confirmed defect was identified.

**REC-TER-01:** document and profile aggregate memory across both decoded caches,
vectors and temporary/rendering allocations when tuning budgets. Consider a vector
byte budget only with density measurements; the current tile-count bound is not
a byte bound. Keep expensive topology work in the worker and preserve explicit
unknown-cell semantics in any optimization.

## Glide

Reviewed the owning guide's delivery, range mathematics, work budgets and accuracy
limits; range map adapter/animation, worker/planner/calculator/profile/sampling;
landing map/display orchestration and verified file/package acquisition. Inspected
the dense-detail/vector fallback boundary. This does not revalidate publisher
screening quality, every polygon-clipping case or aircraft performance.

**RUL-004 also applies:** [map.ts](../../src/layers/glide/map.ts) records
`publishedRanges`, `publishedPlanRevision` and `pinKey` after submission without
source-error invalidation. An unchanged range/airport plan can remain visually
stale after failure even when later worker results are healthy.
[range-animation.ts](../../src/layers/glide/range-animation.ts) observes promise
rejection, but MapLibre's error events also need handling; a resolved source
promise is not sufficient. [landing-map.ts](../../src/layers/glide/landing-map.ts)
acknowledges `renderedKey` before accepting its candidate GeoJSON, allowing the
worker to omit geometry that the map never adopted. Advance that acknowledgement
only after acceptance, and invalidate it on source failure. Preserve separate
data caches so renderer recovery does not restart terrain or file acquisition.

The range engine distinguishes forward descent from reverse airport/site arrival,
retains the terrain buffer and arrival reserve, and stops at unknown sectors.
Whole-cell maxima, 360 sectors and cumulative distance bounds support the
documented conservative model. Source windows cap at 262,144 cells; numeric
resident preparations cap at 32 MiB, pooled reductions at 4 MiB, and completed
airport geometry at 512 entries/8 MiB. These are separate from terrain-reader
memory. Discovery refuses overly broad/dense views rather than silently dropping
airports. Independent origin caches avoid recomputation on camera changes.

The 25 m origin deadband, 250 ms coalescing and fixed 128-bearing/600 ms transition
bound moving-ownship work; transitions intersect with the new footprint. Landing
overview and detail have independent limits and progressive demand. Content
verification, bounded gzip members and pinned source/ownership identity are
retained through package loading. These are useful design choices to keep.

**REC-GLI-01 — Consider the already documented transport cleanup after recovery:** the worker
returns cached airport GeoJSON even when `planRevision` is unchanged, so moving
ownship can repeatedly clone a large unrelated airport union. Let the request
carry an *accepted* airport revision and omit unchanged airport geometry from the
reply. This is the existing guide's proposed improvement, not a newly discovered
unbounded leak. Handle failed submissions/remounts before adding that optimization,
and measure payload size and transfer time to establish its priority.

**REC-GLI-02:** keep range computation, landing acquisition and map acceptance
separate. A local acceptance wrapper using core's helper can reduce repeated
revision/clear logic; do not merge their different invalidation policies into a
single large scheduler. The documented terrain provenance/wind/model limitations
remain product work, not defects inferred from this static review.

## Routes

Reviewed relevant editing/identity invariants in the guide, map contribution and
layer, renderer synchronization and drag reveal, map gesture commit/cancellation
and snapping, route-resource loading/recovery, direct-to guards, atomic draft and
identification edits, one-level expansion, persisted draft/stash validation and
history-worker lifetime. Domain procedure solvers and every picker UI were not
exhaustively re-derived in this plugin pass.

**RUL-004 also applies:** [renderer.ts](../../src/layers/routes/renderer.ts),
`syncRoute`, returns a render state that treats the plan, alternatives and drag
preview as submitted-current. [layer.ts](../../src/layers/routes/layer.ts) retains
it without source-error invalidation. Identical plans skip failed route/comparison
updates. `revealRouteDrag` correctly checks for the expected preview feature before
hiding the original leg, but an initial failed preview leaves `drag.visible = false`
and the submission gate waits for visibility before sending a moved preview.
That gesture cannot recover its preview without a fresh drag or explicit recovery.
Retain the safe original-leg fallback while adding bounded retry/invalidation.

Editing capability follows attachment lifetime and is revoked before cleanup.
Commits check route revision/capability again after clearing a preview, restore
pan/pinch state and reject stale/cancelled gestures. Draft operations preserve
entry identity and procedure attachments according to explicit rules. Direct-to
rechecks the current fix and draft before committing. Shared resource failures
settle independently; healthy collections retain identity during retries. History
keeps one national lookup in a leased worker rather than sending it to React.

The drag-leg source contains only the moving leg and marker; pointer work does not
serialize the whole route for that gesture. Snap bounds are captured once and do
not grow during retention. Saved-text matching strips stable ends and caps its
O(n×m) dynamic-programming table at 1,048,576 cells, rejecting oversized edits
instead of silently dropping attachments. This bounds numeric table storage,
not all JavaScript array/object overhead. No separate confirmed defect was found.

**REC-ROU-01:** preserve the domain/UI ownership boundary and existing shared
resource hook. Apply source acceptance per main/comparison/drag source, retaining
the current cheap drag path; do not rebuild the whole plan for each pointer move.
Group scope-based cleanup with the same lifecycle refactor proposed for the other
adapters rather than creating another Routes-only disposal framework.

## AWC Weather

Reviewed the main guide and relevant numeric-grid/wind contracts; parent controller,
selection/clock and refresh ownership; advisory client/map; forecast controller,
preparation/retention, prepared acquisition and worker admission; wind interpolation;
grid/wind, radar/motion and Progs map acceptance; radar and Progs clients/time
selection. Server ingestion, all GRIB decoding and independent meteorological
qualification are outside this plugin review's scope.

No confirmed defect was identified in those paths. Advisory, wind, radar/motion
and Progs GeoJSON renderers use
[source-submission.ts](../../src/core/map/source-submission.ts), invalidate failures
and hide unaccepted output. Grid/coverage image adapters have their own error
listeners and failed-resource recovery. These paths should inform RUL-004 fixes;
do not apply that finding indiscriminately to every `setData` caller.

Whole-family advisory refreshes preserve successful empty replacements and retain
failed-family data with its original timestamps. Now/expiry and manual selection
are separate from source freshness. Reentrant display receipts do not restart
unrelated acquisition. Forecast controllers distinguish live numeric readiness
from saved receipts, keep prior offline pointers until durable success, stop
speculative work during interaction and reconcile eviction. Prepared artifacts
validate identity and checksum before use. Wind interpolation uses component
values and explicit bracketing, preserving missing/below-ground status.

Numeric worker calls share one CPU admission slot; two scalar acquisitions and
one wind interpolation job have separate admission. A reusable scalar worker
retires after 30 seconds idle. Grid raster retention is capped at three frames /
48 MiB, while file caches and decoded bands have separate ownership and budgets.
Radar limits contour loads to two and drops unselected decoded scans. These are
bounded resource policies, not measured latency or whole-app memory results.

**REC-AWC-01:** keep the existing controller/product split. Source replacement and
layer-order restoration remain renderer-specific; reusing acceptance does not
justify a generic weather renderer. Convert the parent's sequential child cleanup
to independently registered scope disposers when changing this lifecycle, so one
cleanup exception cannot skip later products or controller detach.

**REC-AWC-02:** include aggregate scalar/wind/raster memory and cold-selection
latency in later profiling. Optimize repeated identity serialization or copies
only where measurements justify it; preserve the distinction between display
readiness and successful persistence.

## AHRS

Reviewed sensor/session and validity contracts; plugin bridge and layer ownership;
motion clock, optional magnetic adapter, heading reference, HSI guidance, display
cadence and vertical-speed trend; calibration window; estimator event insertion,
delayed replay, gap/restart and numerical-health paths; covariance propagation,
ordinary/iterated correction; recorder, atomic storage and streaming export.
The full observability/covariance model, every magnetic/heading solver and physical
sensor behavior were not independently re-proved. Existing numerical/device
validation limits remain applicable.

No new confirmed defect was identified in this scope. Sensor startup uses session
guards across permissions/GPS acquisition; revocation cannot revive a cancelled
session. Heading demand shares acquisition without claiming instrument calibration.
AHRS uses normalized GPS acquisition time directly, unlike OWN-001. Missing motion
is not extrapolated; recoverable gaps retain pose/bias with increased uncertainty,
while numerical faults take a separate path. Geographic heading history and its
current confidence are distinct from relative yaw and GPS track.

Delayed observations replay ordered history. Covariance propagation uses bounded
integration steps, corrections preserve Joseph/reset handling, and iterated
reacquisition reuses one prior with a 12-iteration limit. Those are structural
safeguards; they do not establish measured accuracy. The main delayed-observation
history is limited by time and 3,000 events; a retained 30×30 Float64 covariance
alone costs 7,200 bytes per checkpoint (21.6 MB at that count cap). This is a
subtotal, not an AHRS memory bound. The separate
[heading trajectory](../../src/layers/ahrs/estimator/heading-trajectory.ts) retains
covariance and transition matrices over a time window; its entry count depends
on sensor cadence rather than the main history's 3,000-event cap. Other state,
the base checkpoint and temporary/replay allocations add to both histories.
Sensor fusion continues for delivered samples when the toolbox is stowed; display
publication/animation pause. Display animation caps at 60 Hz, control publication
at 20 Hz, heading assistance at 4 Hz, and the VSI downsamples its five-second
history to roughly 26 fixes.

Recorder buffering has a 2 Mi-character threshold and one writer, approximately
128 Ki-character chunks, atomic metadata/chunk commits and a deletion guard that
prevents late writes recreating removed sessions. Recording failure is isolated
from estimation. Export reads bounded pieces in a worker instead of assembling
the complete raw session on the UI thread. GPX intentionally omits duplicate or
backwards raw fix timestamps per its guide; that differs from estimator elapsed
time and is not counted as OWN-001 again.

**REC-AHR-01 — Profile replay and allocation before optimizing:** delayed GPS and
magnetic input can replay multiple covariance checkpoints on the main thread.
Measure callback latency, replay span and allocation on target devices, including
the separate heading trajectory. If this is costly, first target the measured
allocation or array-movement hotspot. Scratch matrices or a history deque are
options, not default requirements. Sparser checkpoints trade memory for additional
replay work and should be a separate, justified algorithm change. Preserve valid
IMU intervals, observation ordering and covariance semantics; dropping samples to make the UI
appear smooth would change the estimator.

**REC-AHR-02:** memoize calibration diagnostics by IMU/GPS evidence revision where
profiling warrants it. `FlightAlignment.snapshot` can rescan a completed-but-rejected
window for each sensor sample and display/status read. Separate time-dependent
staleness from evidence-dependent statistics so repeated reads can reuse the
same calculation. Memoization only saves duplicate reads of unchanged evidence;
every new IMU sample still changes that evidence and may require a new scan.
Establish that duplicate reads are material before adding a cache. Do not change
time weighting or pause/pose-reset semantics.

**Rechecked non-finding:** the adapter's `rotationRate` alpha/beta/gamma → XYZ
mapping agrees with the current
[W3C DeviceMotionEventRotationRate definition](https://www.w3.org/TR/orientation-event/#devicemotioneventrotationrate).
Device-orientation Euler naming is not grounds for swapping these channels.
Physical browser/device conventions still belong in the existing device checks.

## Historical implementation order proposed by the review

This baseline proposal is retained for rationale; the completed dispositions at
the top of this document supersede it as an implementation worklist.

1. Take **OWN-001**, **PLA-001** and **RUL-002** as independent, focused fixes.
   Preserve GPS lease/time units, PDF rendering ownership and renderer capability
   lifetime respectively. None needs to wait for all source adapters to change.
2. Address **RUL-004** incrementally: start with the small Ruler renderer, then
   apply the pattern to affected sources in the other six plugins in separate
   changes. Preserve each adapter's retry/visibility policy. Future verification
   should cover failed clears, unchanged-input recovery, obsolete completions
   and detach; do not perform a blanket replacement of every `setData` call.
3. Fix **RUL-001** and **RUL-003** with bounded geometry/layout work and focused
   future regressions. These can proceed independently of source recovery.
4. Fold disposal hardening into relevant touched adapters when useful. Pursue
   Glide transport and AHRS/calibration optimizations only with measurements.
   Keep optional profiling work separate from the six defect fixes.

This order balances contained user-visible fixes against the breadth of the
failure-recovery work; it is not based on measured production incident rates.

## Consolidation and follow-through

- RUL-001–003 were rechecked against their shared integrations. RUL-004 was added
  during the source-error recovery review. Keep RUL-002 and RUL-004 separate:
  attachment availability and asynchronous source acceptance have different
  failure triggers and fixes.
- The tentative claim that retaining a GPS position jump violated the documented
  motion rejection was narrowed after reading the existing regression. It is
  recorded only as REC-OWN-03, not counted as another defect.
- Ownship's source-error listener already invalidates its rendered snapshot.
  Do not duplicate RUL-004 against Ownship merely because both call `setData`.
- No broad plugin rewrite, extra worker, global cache, continuous redraw loop,
  or micro-optimization of the small bounded geometry loops is recommended.
- RUL-004 is one shared failure mode, with the affected plugin adapters listed
  above. Its original ID is retained to avoid losing earlier references.
- All 12 sections are complete. Shared-boundary findings are recorded once and
  cross-referenced from affected plugins. Recommendations remain separate from
  defects; revise or withdraw entries when further evidence contradicts them.
- When fixes land, update the owning guide and mark the corresponding finding
  resolved with the implementing revision and actual verification scope. Do not
  convert the future verification suggestions above into claimed results.
  Once findings no longer need this standalone record, follow the
  [review retention policy](README.md) rather than keeping duplicate requirements.

## Follow-up verification record

No tests, builds, browser sessions or full verify were run. The local diagnostic
profiling command and its limited evidence are recorded above. Runtime/device
verification remains unexecuted, including the new regression source; these
limitations have not been deleted or relabeled as passing results.

The commit-readiness review inspected the full working-tree diff, including new
files. It corrected the landing-vector retry receipt race recorded above and
registered METAR regression teardown before global-fixture restoration so map
cleanup retains its document/window dependencies. No additional confirmed blocker
remains on static inspection.

The static checks below were repeated after the final implementation changes.

- `node_modules/.bin/tsc --noEmit`: passed, including changed regression source.
- `npm run check:imports`: passed for 568 source modules.
- `git diff --check`: passed.
- Local Markdown link-target scan: 330 local targets across 15 changed Markdown
  files exist; code examples, external URLs and section anchors excluded.
