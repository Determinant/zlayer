# Info server maintenance

The service keeps explicit product owners. `server.ts` composes their lifetime,
HTTP admission and shutdown; it does not interpret source records. The NOTAM
service owns collector transitions, `index.ts` owns local membership, `store.ts`
owns authenticated generations and admission, and `reconciliation.ts` owns
diagnostic full-sync history. Weather retention, NMS and graphical TFR persistence share the small
fsync/rename primitive in `state-file.ts`, without sharing quotas or source policy.

`weather-resources.ts` defines weather HTTP endpoint validation and cache resource
identities/policy; `notams/http.ts` serves bounded local NOTAM responses. HTTP
routing dispatches URLs and is separate from flight-route planning, which stays
in the PWA. Workers share framework-free weather and NOTAM parsers with the client.

Shutdown is an owner transition, not an external observation of idle work. The
[server shutdown contract](README.md#shutdown-and-ownership) closes collection admission before
awaiting admitted work and distinguishes a graceful checkpoint from forced abort.
Deployment must allow the advertised grace plus cleanup time, require a successful
process stop, and keep the latest request journals through rollback. Idle polling
is only a compatibility path for older binaries without the lifecycle protocol.

## Health and diagnostics

Opening `/api/weather/healthz` in a browser shows a compact HTML view of its
readiness assessment. It shows overall readiness, source-check ages, partial
coverage, source errors, reconciliation warnings and unresolved NOTAM counts.
Expected coverage gaps remain distinct from failures; disabled NOTAM collection
is explicit. The page needs no PWA build or additional proxy route. An explicit
`Accept: text/html` preference selects HTML; other clients keep the existing JSON
response. The JSON link uses `?format=json` to show raw data in a browser, and
responses declare `Vary: Accept`.

The page uses core's B612 fonts, palette, compact controls and table styles, with
the device color scheme selecting the shared light/dark colors. The server build
embeds these assets, including the fonts, so direct local access needs no PWA or
asset proxy. Source check times and the page timestamp use core's date formatters.
When embedded styles or scripts change, the next refresh reloads the whole page
to keep its markup, styles and security policy together.

Visible pages refresh every 30 seconds using local server status only, with an
eight-second request timeout. Failed refreshes and snapshots older than 45 seconds
hide the previous status instead of leaving a green result visible. Returning
from a hidden tab or browser history rechecks the page. Without JavaScript, use
the Refresh link; the server timestamp identifies the displayed snapshot. Both
HTML and JSON use `Cache-Control: no-store`. The page makes no source acquisitions
and applies the existing health policy without adding readiness exceptions.
Its inline script opts out of Cloudflare Rocket Loader so CDN rewriting cannot
disable refresh under the page's hash-based Content Security Policy. Check the
delivered script and policy through public HTTPS when deploying behind a proxy.

`/api/weather/healthz` retains its raw product statuses and `ok` process-liveness
flag. `readiness` applies the same freshness limits as the artifact probe, reporting
availability, freshness and coverage separately. Partial terminal-radar coverage,
unpublished NDFD stops and individual storm-motion gaps do not by themselves make
the service unready. A current national scan and current motion observations are
still required. Cache expiry and eviction are normal bounded-retention behavior;
a full cache is not a health failure.
NDFD readiness uses both available and unpublished stops to assess the catalog
horizon, while separately requiring at least one saved image. Unpublished future
images do not invalidate an available current analysis image.
The catalog's explicit analysis time must also satisfy the six-hour limit, whether
its image is available or explicitly unpublished. A successful source check and
distant forecast horizon cannot freshen an old analysis.

The artifact probe requires all weather sources to be available and fresh without
active refresh errors, then independently validates delivered artifacts and advisory
family/check times. Cached files can remain usable during a failed refresh without
satisfying this deployment gate. The NOTAM allowances below waive no weather errors.
Progs exposes its next attempt; chart and grid failure logs report transitions
instead of repeating identical errors on every retry.

`notamSourceIssues` summarizes the committed generation's source ambiguity without
new acquisition: total, association-only, unresolved content, historical, unscoped, blocking
and nonblocking counts, plus at most 16 samples and an explicit truncation flag.
Samples identify the differing fields, raw ICAO alternatives, affected supported
queries, impact, operator action and source events that can clear the issue.
Each sample also includes at most seven `comparisons` against its first retained
variant. These report `equivalent`, `compatible-evidence`, `contradictory` or
`unproven`, the differing fields and the text proof/failure reason. Contradictory
means supplied fields or completely recognized content differ; it does not claim
that FAA intended an operational amendment. Unproven distinguishes unsupported
representations from established differences. These diagnostics grant no readiness
exception. Current unresolved content and incomplete evidence remain blocking;
complete agreeing fixed intervals can become historical under the
[issue-impact contract](../../src/layers/notams/README.md#issue-impact-over-time).
Samples include source revision, diagnostic first/latest observations, source
kinds, applicability and the next clock transition. Historical issues remain raw
evidence and produce their own warning, independently of association metadata.
The [source-comparison contract](../../src/layers/notams/source-comparison.md)
links each transformation to official guidance and retained NMS evidence.
Its [conflict priorities](../../src/layers/notams/source-comparison.md#conflict-resolution-priority)
separate implemented decisions from rules needing additional provenance.
Identity proof now precedes lifecycle and operational-content comparison. The
same identity rules apply to active and inactive observations; a witnessed year
omission can compose with an original-ID cancellation or a complete NOTAMC
envelope witnessing the cancellation message's own identity. NOTAMC headers and
references remain constraints through merges and restart; no reference deletes
another source ID. Deferred observations are reconsidered while admitted evidence
grows. The [composition policy](../../src/layers/notams/source-comparison.md#decision-acceptance-criteria)
requires cross-rule tests in addition to captured-conflict replay. A clean saved
cohort does not establish that future lifecycle combinations are covered.
[Revision ordering](../../src/layers/notams/source-comparison.md#nms-revision-ordering)
uses only precise NMS update time. At equal times, sequence/correction differences
remain comparison evidence; a higher counter, later HTTP response or another
endpoint cannot select a winner. Normal content and positive-cancellation rules
still apply.
`icao-rendering` proves equality of complete enclosing text without declaring
inconsistent structured metadata correct. `icao-distribution-annotation` identifies
qualified USNOF distribution material. `icao-selection-code` identifies a qualified
closure-code correction (including QXXXX replacement); `icao-purpose-upgrade`
identifies the supported supplied-purpose chain, and `icao-qualification` composes
both. These three need stronger record-bound evidence. All original translations
remain available; no synthesized Q line replaces the source.
These proof labels concern representation reconciliation, not certification that
all facts within a source notice are correct.

Revision decisions additionally report `source-year-omission` for a supplied
numbering year backed by complete matching notice evidence, and
`complementary-association-scopes` for the qualified native station/FIR case.
Records retain the actual year spellings in `sourceYears` and original association
sets in `sourceIcaoLocations`; the latter establishes source lookup membership,
not airport aliases. Both rules run during collection and authenticated restore,
with no source requests or clock/admission changes. The release replay reports
their proofs and resulting query/health changes through its existing review gate.
The `fdc-continuation` text proof identifies the qualified ODP repeated-footer/
airport-heading representation family described in the
[NOTAM reconciliation contract](../../src/layers/notams/README.md#collection-and-delivery).
It requires a complete current native notice plus an agreeing complete ICAO
conversion. Authenticated restore re-evaluates retained variants with that proof;
it preserves source clocks and admission journals and makes no source request.
Association-only means the existing filing-scope proof supplies usable matching
content while source aliases disagree; it does not resolve those aliases or remove
the durable issue. Cold collection reports null. `source-issues.ts` uses the same
proof for publication and readiness: a current issue is nonblocking only when
complete, scoped evidence establishes usable content and none of the disputed
ICAO/FIR associations selects a supported query. Historical qualification is
separate and retains all source uncertainty. Other issues block readiness.
`blockingRecords` governs feed state/error and the release probe; legacy responses
without it treat every unresolved record as blocking. Aggregate health retains
nonblocking ambiguity in `readiness.warnings`, independently of its blocking
`problems`. Source coverage and legacy `continuity` remain partial/incomplete.
For example, the captured October 9 `49D`/`PA49D` pair has
matching content and filing location but conflicting FAA ICAO-location fields;
the schema allows both values, so neither may be selected by a format guess.
Neither matches the supported four-letter ICAO/FIR query grammar, so this specific
disagreement requires no operator action and does not block readiness. PJOH/PACV
does affect supported queries and remains blocking. Neither classification clears
the retained evidence or changes timestamps; a newer reconciled source revision
or qualified full-snapshot withdrawal can clear the issue.

`notamReconciliation` reports the last completed full sync, its age, a pending
replacement, the last attempt/failure, and the next budget-eligible attempt. A
24-hour interval plus ten minutes for download/bridge is the warning threshold.
Fresh deltas do not clear a failed or overdue full sync. Complete publication of a
newer full generation resolves its active failure. Optional checksummed
`reconciliation.json` survives restart; missing history in older releases is
accepted. Corrupt/unwritable history is visible but cannot grant quota, invalidate
otherwise authenticated notices, or freshen source times. An interrupted attempt
without a pending candidate is explicit.
An orphaned history file is evidence of prior provisioning: it cannot authorize
fresh quota when the admission journal and provisioning marker are missing.

Storm-motion diagnostics retain at most 160 station entries with fixed reason
codes, first/latest failure times and counts. Codes distinguish stale/future or
invalid products, source transport/backoff, local storage and processing failures.
They log reason changes and recovery, not identical errors every round. A retained
station count can include old scans; `newestObservedAt` describes the latest
published snapshot and establishes current availability. A pending scan cannot
change that timestamp, including when tolerated source clock skew places its
observation slightly in the future. Restore derives it from the published file.
Advisory background refresh has an explicit owner, per-product
checked/retry times and errors; one failed family cannot hide behind successful
families. SIGMET/CWA background checks normally occur every 30 seconds and refresh
inputs older than 20 seconds, leaving time before the 60-second delivery TTL.
G-AIRMET acquires the complete minute-updated AWC gzip/XML cache once per minute
after success. Its prior complete package survives transient failures for at most
ten minutes from the original source publication; HTTP reads and restart cannot
advance that time. Availability and failed acquisition remain independent: a
retained package can be available while `error` still fails readiness and the
strict release probe. Stale/future Last-Modified, regressing publication/cycle,
malformed XML and incomplete envelopes cannot replace the last valid package.
Published advisory files are protected from disposable-input cache pressure.
Restore of the former G-AIRMET API source immediately schedules bulk acquisition;
the legacy file remains protected during that replacement even when its stored
60-second eviction lifetime elapses. Delivery still applies the current product's
age limit. The upgrade regression combines restoration, a pending replacement,
legacy expiry and a full cache; a healthy initial restore alone did not cover it.
Failed products wait at least 30 seconds and obey upstream backoff. Cold/expired
HTTP misses still share the cache's existing acquisition.

The October 9 investigation traced recurring G-AIRMET 502s to upstream HTTP 504s
in the former five-query timestamp-pinned acquisition. One passing retry did not
establish recovery. `gairmet-cache.test.ts` covers complete source equivalence,
outage/repeated readers, restart, expiry, regression, and successful replacement;
qualification must also observe successive minute-paced acquisitions from the
deployment host and advancing public source times after activation.

`runtime` reports process memory, peak RSS, lifetime event-loop delay and fixed
latency buckets for HTTP delivery and forecast/NMS operations. Request durations
include encoding and slow clients; abandoned responses and server errors count as
failures. Operation timings distinguish acquisition, parsing, merging, persistence
and index publication. Percentiles are bucket upper bounds. Event-loop delay uses
a 20 ms sampling resolution; these are process-lifetime diagnostics, not a durable
metrics database or cgroup memory accounting.

The [cache contract](README.md#source-and-cache-contract) defines product storage
and eviction counters and publication queue timing. Use those measurements to
distinguish source-input reuse, released output retention and publication pressure
before increasing cache capacity.

## Focused qualification

Run `npm run test:info:notams` for NMS identity/representation composition,
collection, admission, delivery, authenticated recovery and readiness. This
includes generated combinations over retained source profiles, explicit rejection
cases and the existing collection-cycle simulation. Unknown source semantics and
actual contradictions remain observable; qualification never requires clearing
all issues by weakening evidence checks.

Run `npm run check:imports`, appropriate TypeScript checks, relevant
`node --import tsx --test ...` suites and
`npm run info:build`. Full repository verification is a separate release policy;
do not infer it passed from these checks. Recovery/health tests live in
`test/notams-admission.test.ts`, `notams-server.test.ts`,
`notams-reconciliation-health.test.ts`, `info-health.test.ts` and
`info-advisories.test.ts`. Existing persistence, lifecycle, delivery and weather
worker tests cover their respective boundaries.

Changes to health classification must exercise the retained source fixture through
feed status, HTTP health and scoped reads, aggregate readiness, and the artifact
probe. Diagnostics alone do not establish the decision is correct. Regressions
include metadata-only evidence, supported disputed queries, substantive conflicts,
truncated/unscoped evidence, a blocking issue beyond the diagnostic sample limit,
and independent collection/freshness/reconciliation failures.

### Retained-state release replay

The server build includes `replay-notams.js`. Give it a frozen environment
checkpoint directory containing `current.json`, its authenticated NDJSON and the
admission/provisioning journals. It rejects symlinks and restores independent
temporary copies with fake credentials, updates disabled and all source calls
rejected. Baseline and candidate receive the same frozen input and clock.
The gate checks source boundaries, collection completeness and byte-identical
journals, then compares records, issues and every supported single-selector
airport/navaid/ARTCC/FIR query. It reports content and membership hashes, named
resolution proofs, per-issue query impact, operational health differences and health
diagnostics. Combined-selector union behavior remains covered by the focused HTTP tests.

```bash
node tools/info-server/dist/replay-notams.js /private/frozen/production production \
  --baseline=/private/previous/server.js --at=2026-10-16T21:52:26.208Z \
  --output=/tmp/notam-replay.json --report-only
```

Review the report against the intended contract changes. Rerun the same frozen
input, baseline and clock with `--expect=/private/reviewed-notam-replay.json` to
require exact agreement on record, query, impact and health changes. A supplied
review cannot waive source requests or changed clocks/journals. A report-only run
does not satisfy the release gate. Input checksums/journals must remain unchanged
through replay; a changing live directory is not a qualified frozen input.
Output reports must be new files outside the frozen input; a report cannot
overwrite its expected review.
Retain private inputs/reports outside the public source tree. The private deployment
helper owns staging, review binding and activation; no replay operation restarts
production or resets admission.

Reliability qualification must cover successive refreshes at realistic feed sizes,
not only a healthy startup. `notams-tfr-scheduling.test.ts` checks both clocks over
repeated 90-notice rounds and restart, as well as near-timeout queues that must
yield to index checks. Progs tests exercise retained publication through malformed
inputs, upstream outages and catalog regression, recovery at the retry deadline,
same-cycle corrections, and restart. Cache tests cover shared quarantine deadlines
and delayed rejection racing a newer observation. Artifact-retention regressions
cover replacement followed by repeated restarts, the original grace deadline,
concurrent product publications, failed retention writes, and smaller byte/entry
limits while owners repair catalogs during startup. Clock-correction tests check
source reacquisition, rejection of older runs with valid source-check times, bounded cache failures,
and elapsed-time upstream spacing/backoff. Real overload, source outages
and unresolved source ambiguity must remain visible; these checks do not promise
permanent green health or waive the existing release gate.

For an offline overlap replay:

```bash
node --import tsx tools/replay-info-workload.ts /tmp/info-overlap.json 90000
```

It uses invented notices, a real bulk parser/bridge/publication, forecast workers,
disk caching and concurrent HTTP reads. It uses fake credentials and fixture
sources only. Weather grids are small: this qualifies responsiveness under that
workload, not production weather memory capacity. Compare identical runs before
and after performance changes, without other test workloads competing for CPU.

For a bounded read-only sample of a running server:

```bash
node --import tsx tools/profile-info-server.ts http://127.0.0.1:8787 /tmp/info-profile.json 60 2
```

This samples health and local NOTAM routes only, at most ten requests/second per
reader, with bounded duration and 1–8 readers. It never requests FAA collection or
uncached weather reports. During a normal full sync overlapping weather updates,
capture these metrics and the service manager's memory peak, restart count and
memory-event counters. Do not spend another daily allowance to obtain a profile.

Compatible rollouts must qualify both candidate and rollback code with independent
state copies, disabled updates and rejected source fetches. Publish exact build
source before activation. Stop/drain the old owner before starting the replacement;
retain the latest NMS and TFR journals through failure or rollback. A pre-existing
overdue full sync may be explicitly reported by the artifact probe's
`--allow-overdue-full-sync` option; the default remains strict, and future source
times, stale deltas, lost continuity and missing artifacts are never waived.
For enabled NMS collection, the probe also requires a reconciliation summary with
no active error. Failed/interrupted reconciliation and corrupt or unavailable
history fail the probe even when deltas are fresh and the last full sync is recent.
A pending replacement with a healthy live feed can pass. The overdue-age exception
does not waive reconciliation errors or missing diagnostic status.

A compatible rollout may also supply `--allow-unresolved-notams=N` for a captured
pre-existing source ambiguity. The probe still requires fresh, continuous
collection and reports the blocking issue count in `warnings`. Proven nonblocking
metadata needs no allowance and is reported separately as
`notam-association-metadata:N`. A deployment must
independently compare source IDs against its stopped baseline; a numeric allowance
alone does not prove the candidate preserved the same ambiguity.
This source-issue allowance also cannot waive reconciliation failures.
