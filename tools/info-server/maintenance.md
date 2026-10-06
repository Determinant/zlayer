# Info server maintenance

The service keeps explicit product owners. `server.ts` composes their lifetime,
HTTP admission and shutdown; it does not interpret source records. The NOTAM
service owns collector transitions, `index.ts` owns local membership, `store.ts`
owns authenticated generations and admission, and `reconciliation.ts` owns
diagnostic full-sync history. NMS and graphical TFR persistence share the small
fsync/rename primitive in `state-file.ts`, without sharing quotas or source policy.

## Health and diagnostics

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
families. Healthy background checks normally occur every 30 seconds and refresh
inputs older than 20 seconds, leaving time before the 60-second delivery TTL.
Failed products wait at least 30 seconds and obey upstream backoff. HTTP misses
still share the cache's existing acquisition.

`runtime` reports process memory, peak RSS, lifetime event-loop delay and fixed
latency buckets for HTTP delivery and forecast/NMS operations. Request durations
include encoding and slow clients; abandoned responses and server errors count as
failures. Operation timings distinguish acquisition, parsing, merging, persistence
and index publication. Percentiles are bucket upper bounds. Event-loop delay uses
a 20 ms sampling resolution; these are process-lifetime diagnostics, not a durable
metrics database or cgroup memory accounting.

## Focused qualification

Run `npm run check`, relevant `node --import tsx --test ...` suites and
`npm run info:build`. Full repository verification is a separate release policy;
do not infer it passed from these checks. Recovery/health tests live in
`test/notams-admission.test.ts`, `notams-server.test.ts`,
`notams-reconciliation-health.test.ts`, `info-health.test.ts` and
`info-advisories.test.ts`. Existing persistence, lifecycle, delivery and weather
worker tests cover their respective boundaries.

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
collection and reports the retained issue count in `warnings`. A deployment must
independently compare source IDs against its stopped baseline; a numeric allowance
alone does not prove the candidate preserved the same ambiguity.
This source-issue allowance also cannot waive reconciliation failures.
