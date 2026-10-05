# Airport and procedure NOTAMs

[Documentation](../../../docs/README.md) / Plugins / notams

**Status: implemented locally; staging exercised.** This is the long-term owning
guide for the NOTAM plugin, collector, supported interpretation, and remaining
qualification. Production collection is disabled by default. The
[roadmap](../../../docs/product/roadmap.md#airport-and-procedure-notams) tracks
release work. Requirements below retain the intended scope; the implementation
coverage and dated evidence distinguish supported behavior from remaining work.

The plugin shows both domestic NOTAMs (D) and Flight Data Center NOTAMs (FDC)
in a third airport-detail tab, with concise flairs and a **Show raw** disclosure
for every entry. Relevant notices also appear in an expandable red **NOTAM**
bar in the plate reader, especially amendments to IAPs, SIDs, and STARs.
One data client and entry renderer serve both views.

Implemented in this tree:

- `plugin.ts`, `client.ts`, `storage.ts`: one optional workspace provider, coalesced
  visible demand, three-minute reads, bounded saved snapshots and explicit source
  freshness/offline state. `/api/notams/` is excluded from service-worker caching.
- `parser.ts`, `validity.ts`, `matcher.ts`, `ui.tsx`: conservative D/FDC flairs, full text/raw
  disclosures, airport filters, procedure/runway matches and review candidates.
  All defaults to D/FDC and unclassified records; Other also exposes retained
  international/military records. Those classes do not duplicate D/FDC plate counts.
- Navigation's third tab and Plates' row counts/red disclosure use core controls.
  The workspace's optional bridge composes the UI. The plate disclosure stays
  focused on the displayed plate; the full airport list lives in the NOTAM tab.
- Plates pins the catalog resource in new selections and resolves each book page
  by exact URL/hash/index. Legacy selections without that resource remain readable
  but report matching unavailable; reopening from the catalog supplies the pin.
- The existing weather process owns OAuth, all-class full sync, global deltas,
  durable quota admission, checksummed generations, local reads and feed health.

Current interpretation limits: explicit IAP headings, named SID/STAR headings,
all-IAP scope, runway identity and explicit runway ILS/LOC/glideslope outages are
supported. Ambiguous procedure targets are review candidates; facility dependency
graphs, broader regional applicability,
multipart assembly and every publisher alias are not established. Simple daily
and weekday/range UTC schedules with one time window are evaluated, including
overnight windows. Other schedules remain **Check Schedule**. These limits cannot
establish complete operational applicability. Production entitlement, deployment
capacity alongside weather, device checks and broader source comparison remain
release work.

## Contents

- [Scope and ownership](#scope-and-ownership)
- [Airport detail tab](#airport-detail-tab)
- [Plate NOTAM bar](#plate-notam-bar)
- [NMS source contract](#nms-source-contract)
- [Staging evidence, October 4, 2026](#staging-evidence-october-4-2026)
- [Collection and delivery](#collection-and-delivery)
- [Airport query contract](#airport-query-contract)
- [Info server integration](#info-server-integration)
- [Normalized records](#normalized-records)
- [Parsing and flairs](#parsing-and-flairs)
- [Procedure matching](#procedure-matching)
- [Client lifecycle and offline behavior](#client-lifecycle-and-offline-behavior)
- [Implementation sequence](#implementation-sequence)
- [Verification](#verification)
- [Open source questions](#open-source-questions)
- [References](#references)

## Scope and ownership

The first release covers airport-associated D and FDC notices, procedure
amendments and restrictions, and runway/facility notices whose relevance can be
established. FDC is a classification, not a synonym for an approach amendment:
retain its other subjects when associated with that airport. Classification and
subject keyword remain separate throughout the UI. The ICAO series letter is not
the NOTAM classification and must not determine the D/FDC flair.

Airport association is not a complete route briefing. ARTCC-wide, regional GPS,
national, and nearby airspace notices require additional applicability rules;
an airport location query or airport-point geometry alone does not establish that
coverage. Document supported scope and qualify those rules before expanding
it. A graphical NOTAM map, route-wide briefing, automatic route changes, and
changes to printed PDF content are outside this first implementation.

Ownership follows the [plugin contract](../../../docs/architecture/layer-plugins.md):

| Owner | Responsibility |
| --- | --- |
| `src/layers/notams/` | Client snapshots, demand, parsing, matching, entries, flairs, filters, and freshness presentation |
| Navigation | Airport detail frame, ordered content tabs, and saved tab selection |
| Plates | Document/edition identity, displayed page context, PDF lifecycle, and placement of the NOTAM bar |
| Workspace | Stable registration and composition of airport and plate NOTAM views |
| Shared server | NMS authentication, one collector, normalization, complete generations, and bounded airport queries |
| `packages/contracts` | Versioned delivery types and runtime guards shared by server and client |
| Core | Requests, refresh scheduling, scoped storage, optional plugin connections, controls, panels, and time formatting |

Use the stable plugin ID `notams`. Expose a small data-only `NotamsApi` through
`workspace/plugin-apis.ts` and register one instance in `workspace/products.ts`.
The public surface needs scoped airport demand, observable snapshots, and typed
match results. Keep React components out of the public contract. Integrate with
Plates through the optional bridge and Navigation through explicit workspace body
props. Disconnect releases demand and clears derived results without closing the
PDF or removing the selected airport.

The [info server integration](#info-server-integration) uses the existing
`tools/info-server/` process and deployment. Collection and query contracts
below define its NMS responsibilities.

## Airport detail tab

The tab order is **Info | Plates | NOTAM**. NOTAM is available for an identified
airport when the plugin is enabled, including airports without plates. It must
not depend on the existing `hasPlates` condition. Omit disabled providers' tabs
while preserving the remaining order. An unavailable saved tab falls back to Info
without deleting its saved preference.

Use core `TabList`, `tabPanelProps`, and `DetailPanel`. Extend Navigation's saved
tab validator to accept `notams`, preserving existing records and their bounded
retention. Inactive bodies unmount; stowing retains mounted content and UI state
while withdrawing visible refresh demand.

Default to **All**, showing D and FDC together. Offer classification and subject
filters plus text search using core controls. Include Other/Unclassified so
imperfect parsing never hides a notice. Show filtered and total counts, and reset
transient search/filter restrictions on a different airport. These filters do not
affect the plate bar's results or counts.

Include current and published upcoming notices, with future notices marked.
Order current notices before upcoming ones, then newest issued first with a stable
ID tie-breaker. Unknown timing stays visible in a labeled group. Expired/cancelled
notices leave the current list only on validated lifecycle/time evidence; retained
history is separate and bounded. Do not infer severity from FDC versus D.

| Entry element | Contract |
| --- | --- |
| Identity | Source number and location, with classification `D` or `FDC`; preserve unknown classifications explicitly |
| Subject flairs | Source-backed topics such as Runway, Taxiway, IAP, SID, STAR, Navaid, Obstruction, or Airspace |
| Effect flairs | Scoped effects such as Runway Closed, Lighting Unavailable, Procedure Amended, or Circling Unavailable, only when established |
| Body | Conservative formatting retaining every operational clause, condition, exception, value, and unit |
| Validity | Start/end in device-local time with Zulu in parentheses, schedule, estimated/permanent qualifiers, and timing uncertainty using core time formatting |
| Source state | Environment-specific source status and retry above the list, as described below |
| Raw disclosure | **Show raw** containing the complete original local-format text and any ICAO translation, separately labeled |

Staging snapshots show one notice above each airport list or expanded plate list:
**Testing with FAA staging data. Notices may be incomplete. Do not use for flight
planning.** This replaces source-age, stale, incomplete and degraded-feed messages
and repeated feed-coverage qualifiers on counts. Offline state, request failures,
retry actions and procedure-specific interpretation/review qualifiers remain visible.
Empty staging results describe retained notices without implying current completeness.
Production snapshots retain source-check time and freshness/coverage status.

Raw text is selectable/copyable, retains line breaks, and wraps on narrow screens.
Validity labels use the shared local-first timestamp pair, for example
`From Oct 4 · 09:00 PDT (16:00Z)`. When local and UTC calendar days differ, include
the UTC date inside the parentheses. Display the local zone at each instant so
daylight-saving transitions remain explicit. Source schedule and raw NOTAM times
retain their supplied notation.
If a complete translation is missing, expose available source text and label that
limitation; never present a reconstructed full NOTAM as original. Render strings
as text. Disclosure expansion is session state keyed by source ID/revision, not
an unbounded collection of persistent records. Material revisions must not inherit
an old read/dismissed state.

Reuse `ui-button`, `ui-input`, `LoadingPlaceholder`, typography, focus treatment,
and scrollbars. List counts, completeness qualifiers and empty-list messages use
the compact 12 px secondary-text style, wrapping on narrow panels without extra
paragraph margins. Flairs are feature presentation using semantic theme tokens;
their text conveys meaning independently of color. Use native disclosures as
Navigation does for frequency notes, without adding a UI library.

## Plate NOTAM bar

Place a horizontal strip between the plate heading and PDF reading area, with
centered **NOTAM** text, a count, and an expand/collapse chevron. This is the middle
bar in the reader layout, not a mark drawn onto the source PDF.

When relevant notices exist, the strip is red. Clicking expands the shared entry
list inline. Separate **Applies to this plate** from **Review applicability**, and
distinguish upcoming notices. The collapsed count includes displayed non-expired
matches and review candidates; label the review count separately when present.
Count each source notice once even if several clauses match. Multipart groups
retain their individual parts' identities and counts.

The expanded area has a maximum height based on available reader height and its
own scrolling. Keep the collapse control, PDF controls, and some reading area
reachable on short phones. The disclosure participates in layout rather than
covering chart content. Scrolling it must not trigger PDF pan/zoom. The strip stays
reachable while its list or the PDF scrolls.

| Data state | Bar behavior |
| --- | --- |
| Current matches or review candidates | Red strip with counts, timing qualifiers, and expandable entries |
| Complete, fresh query with zero matches | Neutral `NOTAM · 0 matched`, limited to the supported scope |
| Loading without a snapshot | Loading state, never a zero count |
| Saved/stale snapshot | Retain known results and identify their age; zero must not imply a current check |
| Partial feed, unresolved page, or failed query without data | Explicit incomplete/unavailable matching state with recovery |

The expanded strip shows notices for the displayed plate. The airport's NOTAM tab
owns the full list; omit the **Show all airport NOTAMs** button and nested full-list
fallback. Apply the staging presentation above; production keeps source freshness
and actual incomplete states visible. Unresolved interpretation remains explicit in
both environments, without repeating general regional/route-scope explanations.
Counts beside IAP/SID/STAR rows in the Plates list use the same airport snapshot
and matcher, without a request per row.

Support both side-reader and fullscreen `PanelSurface`. Use core focus/touch
sizing, `aria-expanded`/`aria-controls`, and a labeled scroll region. Red denotes an
alert; core's danger-button variant denotes deletion and should not be repurposed.
Keep focus valid when collapsing and announce status changes without stealing
focus or repeatedly announcing each refresh.

Opening, updating, or collapsing NOTAMs must not remount/refetch the PDF, recreate
its worker, or reset scroll/zoom/rotation. Reuse existing reader height-change
handling. NOTAM loading and failure remain independent of PDF loading and failure.

### Displayed page identity

Users can navigate an entire combined TPP volume, so the original
`ProcedureSelection` cannot identify every displayed page. Plates must expose
context for the actual rendered page, tied to exact catalog identity, document
hash/URL, page index or named destination, airport, and edition.

Resolve indexed book pages through the owning catalog. Continuations share a
procedure only when publisher identity and consecutive targets establish it, as
current Plates grouping requires. Individual PDFs retain their explicit procedure
target. Shared minimums documents require airport-specific context. Unresolved or
ambiguous pages show matching unavailable; never carry a previous airport's
confirmed notices onto another page.

The context retains airport FAA/ICAO IDs, procedure kind/name, publisher procedure
ID/computer code, amendment metadata, and catalog resource identity. The current
selection type promises only airport ID and procedure ID/name/kind, despite richer
catalog records. Extend and validate it deliberately, including saved-selection
compatibility. Legacy selections may recover context from their exact catalog;
they must not silently adopt another edition.

## NMS source contract

The supplied onboarding package was reviewed on 2026-10-04. It establishes staging
onboarding, not production readiness. Use the dated OpenAPI specification and FAQ
as the planning baseline, resolving the discrepancies below during qualification.

| Supplied material in local `nms/` | Evidence and limitations |
| --- | --- |
| `Gmail - Onboarding onto NMS-API - INC0033186.pdf` | September 25, 2026 staging onboarding; validate before requesting production next steps |
| `Gmail - Follow-up Email.pdf` | Separate workbook password delivery; no product/data contract |
| `ZLayer.xlsx` | Read in memory with the supplied password; contains Key and Secret; values excluded from documentation/fixtures |
| `FAQ NMS-API.pdf` | Authentication, token expiry, content authorization, environment caveats, and request limits, especially page 5 |
| `nms-api.yaml` | OpenAPI 1.0.18, revised February 12, 2026; endpoint/schema baseline |
| `nms-api_curl_examples.txt` | Connection examples; direct signed-URL wording predates the content-proxy contract |
| `NMS-API-Pre-Prod-soapui-project_sample.xml` | REST configuration despite the SoapUI name; older parameter descriptions and embedded authentication material |
| `nms_api_initial_load_example.json` | Historical signed GCS URL response; not a reusable URL or NOTAM payload |
| `nms-api_sample_initial_load.xml` | SOAP/AIXM domestic lighting and ARTCC UAS examples; two members despite a collection count of 21,468, so not a complete-load fixture |
| `nms-api_checklist_example.json` | Active inventory IDs, classifications, locations, accountability and update times; no bodies |

Keep private onboarding artifacts separate from tracked documentation, public
assets, and sanitized fixtures. Their continued presence is not needed to understand
this guide. Do not copy credentials, tokens, passwords, or signed URLs into logs,
builds, source examples, or browsers. No authenticated requests were made during
the initial documentation review; the subsequent implementation exercise is
recorded below. Vite denies `nms/` and `.cache/` as development assets.

### Staging evidence, October 4, 2026

One all-class initial load and budgeted global deltas were exercised against the
supplied staging host, using the collector's durable journal. No production
requests or deployment were performed. Private source captures and credentials
were excluded from tracked files; regression fixtures use invented content.

- OAuth returns decimal-string `expires_in` and `BearerToken`; the adapter also
  accepts numeric expiry and `Bearer`. Renewals use the actual expiry.
- The gzip bulk declared and delivered **74,831** members: 20,854 DOM, 4,676 FDC,
  43,907 INTL and 5,394 MIL. Its timestamp was `2026-10-04T22:48:04.879Z`.
  The compressed file was 44,814,701 bytes. Complete normalization took about
  nine seconds on this development host; normalized records occupied about 93 MB.
- Some `lastUpdated` timestamps have nine fractional digits. Ordering retains
  their original precision. Some messages contain an additional annotation-only
  EventTimeSlice; exactly one NOTAM-bearing slice is required. ICAO translations
  use `formattedText` with XHTML, preserved as inert text with line breaks.
  A year-0001 placeholder becomes unknown time. Some source bodies exceed 64 KiB;
  the bounded text limit is 256 KiB per body/translation.
- Global deltas include original source IDs with `FNSE:canceled` timestamps.
  These become tombstones. Type C is a separate cancellation notice and never
  identifies the cancelled source ID by itself. Type R remains an active
  replacement; the old notice's cancellation arrives on its own source ID.
  Structured referred series/number/year and raw translations are retained.
  Some legacy bulk records omit type; absent `canceled` retains their source state.
  Unknown change types or invalid cancellation timestamps fail the update.
- A 29-member delta included 15 original-ID cancellations, seven active records
  and seven cancellation messages. A later collector round restored the candidate,
  bridged from its source timestamp, and published 72,306 retained records after
  old cancellation-message/tombstone pruning. Local MIA, SAC and SNA reads worked.
  The complete exercise reached about 507 MiB RSS with qualification buffers
  still retained. This is evidence of a working path, not a shared-weather
  capacity or production-completeness qualification.
- FDC SID headings often list several `… DEPARTURE...` lines without amendments.
  Some FDC records carry EST only in the original text's validity suffix; the
  adapter requires it to identify the same structured end time before applying
  the estimated qualifier.

### Authentication and environments

Staging data uses `https://api-staging.cgifederal-aim.com/nmsapi`; production is
listed as `https://api-nms.aim.faa.gov/nmsapi`. Authenticate at the chosen host's
`/v1/auth/token`, without `/nmsapi`, using OAuth2 client credentials and
`grant_type=client_credentials`. Provision credentials in server configuration.
The example lifetime is 1,799 seconds; honor actual `expires_in`, coalesce renewal,
and bound retries after 401. Invalid credentials differ from an expired token.

Staging can contain test-generated notices. Include environment in dataset/cache/
checkpoint identity; staging data must never appear as production. Retain normal
TLS verification; examples weakening certificate checks are not adapter policy.

### Endpoints and request budgets

| Endpoint under `/nmsapi` | Planning contract |
| --- | --- |
| `GET /v1/notams/il` | All active classifications in compressed SOAP-wrapped AIXM; one complete bootstrap/rebase |
| `GET /v1/notams/il/{classification}` | Same AIXM format for one classification; does not select GeoJSON |
| `GET /v1/notams` | Required `nmsResponseFormat: AIXM` or `GEOJSON`; filters combine with AND; no-parameter request is invalid |
| `GET /v1/notams?classification=…` | A sole classification filter returns full-classification content through a temporary URL; other filters return data directly |
| `GET /v1/notams?lastUpdatedDate=…` | Created, updated and cancelled notices, including inactive records; YAML limits lookback to 24 hours |
| `GET /v1/notams?nmsId=…` | One active/inactive notice for diagnosis or repair within budget |
| `GET /v1/notams/checklist` | Active inventory, optionally filtered by location/accountability/classification; reconciliation cadence needs qualification |
| `GET /v1/locationseries` | YAML specifies active mappings without a date; dated deltas include N/U/D statuses, with five-day lookback |
| `GET /v1/content/{token}` | Authenticated binary proxy; temporary references expire after five minutes |

The FAQ specifies pre-production limits of one request per second, approximately
two per second for content, and at most one delta pull every three minutes.
Production allows one data pull every three minutes and at most one bulk pull per
24 hours using initial-load or full-classification retrieval. More frequent use
needs FAA approval. These are shared credential limits across replicas, restarts,
retries, and administrative tools, not per-browser allowances.

Do not assume separate DOMESTIC/FDC bulk calls have separate daily quotas. Use one
all-classification AIXM initial load and AIXM deltas initially, with one normalization
path and JSON delivery to browsers. Retain every current record delivered by that
authorized feed, across classifications; apply the first release's D/FDC display
scope locally. GeoJSON remains an option once its benefits and bulk budget are
established. `DOMESTIC,FDC` is not a documented classification value.

Location accepts domestic/ICAO IDs. Accountability identifies the issuing office,
not the airport. Effective start/end filters must be paired; geospatial requests
require latitude/longitude/radius together, with radius limited to 100 NM. Do not
add active-location filters to the global delta until their interaction with
cancelled records is proven.

### Conflicting and incomplete examples

- SoapUI describes a 72-hour NOTAM delta window; YAML specifies 24 hours. Plan for
  24 until confirmed otherwise. SoapUI's location-series default is a one-hour
  window, whereas YAML specifies active initial load without a date.
- Older JSON/cURL/SoapUI use direct signed GCS URLs. Newer YAML/FAQ use an
  authenticated content proxy. Examples vary between `/v1/content/…` and
  `/nmsapi/v1/content/…`; resolve documented forms against the configured host
  without duplicating or dropping `/nmsapi`.
- Records may use `DOM` while request/checklist classification is `DOMESTIC`.
  Payload IDs may start `NMS_ID_` while query IDs are 16 digits. Preserve originals
  and normalize only demonstrated equivalents.
- The schematic GeoJSON example pairs `type: N` with a NOTAMR translation, has
  string-valued fields, and includes an incomplete polygon. It does not establish
  replacement semantics or valid geometry.
- A `feature` query filter does not guarantee a structured keyword or a d-TPP
  procedure identifier in each returned record. Text parsing/catalog matching
  are still needed.
- The examples do not qualify FDC amendments, lifecycle chains, multipart
  completeness, all schedules, or airport-association coverage.

## Collection and delivery

Maintain a complete local copy of the current NOTAM dataset available through our
NMS credentials. Retain normalized records and complete raw translations for all
locations and classifications delivered by the feed, including published upcoming
notices. The first PWA query for an airport is served locally just like a repeated
query. Collection runs independently of which airports users view or how many
queries they make.

All supported PWA queries use this dataset. Complete means the authorized NMS feed
at a verified source boundary; operational applicability follows the narrower
[product scope](#scope-and-ownership).

### Sync policy

| Work | Implemented cadence and behavior |
| --- | --- |
| Initial full sync | One all-classification initial load when no usable baseline exists and the durable bulk budget permits |
| Incremental sync | Target one global delta every three minutes; include created, updated and cancelled records, with overlap |
| Scheduled full reconciliation | Target one all-classification full sync per rolling 24 hours, never sooner than 24 hours after the preceding bulk attempt; rebuild and reconcile even when deltas appear healthy |
| Recovery full sync | Use the same bulk allowance after lost continuity or invalid state; no separate emergency quota or restart allowance |
| Browser query | Local indexed read only, including new airports and query-result cache misses |

Full syncs and deltas use the same collector and shared data-pull admission.
A scheduled full pull takes an allowed request slot; it does not run beside a
delta in violation of the three-minute limit. Fetch referenced content within its
lifetime using the qualified content-endpoint allowance. Backoff and failed
attempts can postpone either schedule. Do not run catch-up bursts after downtime
or interpret a new calendar day as a reset of the rolling bulk limit. Checklists
remain an optional additional check after their request accounting is qualified.

1. Restore a verified generation containing environment/source identity,
   schema/adapter version, records, watermark and source check, plus the independent
   quota journal. Restart or generation rollback must not reset the bulk allowance.
2. Bootstrap when no usable baseline exists and budget permits. Download content
   within its lifetime; stream decompression and namespace-aware XML parsing.
   Enforce compressed/expanded-byte, record, depth and per-record limits, and
   disable external XML entities.
3. Establish the baseline's actual timestamp and bridge its changes through the
   present. Retrieval time is not snapshot time. Do not declare completeness if
   the gap cannot be closed within the supported lookback.
4. Pull deltas at most every three minutes, with a conservative overlapping lower
   bound for timestamp precision/repeated delivery. Merge idempotently by source
   ID and qualified revision/update metadata.
   The current overlap is ten minutes, accommodating timestamp precision and
   delivery lag while remaining inside the 24-hour query window. It is not proof
   of an upper bound on FAA delivery latency.
5. Advance the watermark only after the entire response is validated and applied.
   Use a qualified source boundary or conservative request-start boundary, not
   response completion or the newest record. An empty delta follows the same rule.
6. Apply replacement/cancellation events using verified source semantics. Retain
   tombstones long enough to prevent resurrection from overlap. Absence in a delta
   or a shared display number is not cancellation evidence.
7. Commit records, index, watermark and freshness as one complete generation.
   Continue serving the preceding generation while preparing. HTTP 200 alone is
   insufficient: check envelope `status`, `errors`, format and full consumption.
8. Perform scheduled full reconciliation even when continuity appears healthy.
   Build a candidate from the complete bulk load, bridge its deltas through at
   least the published generation's watermark, and then atomically replace the
   live generation. Retain the preceding generation while downloading/validating;
   an older bulk timestamp must not regress already published updates.
9. Compare source IDs/revisions across the complete generations. A notice absent
   from a verified, equivalently scoped full snapshot can leave the current set
   only after the snapshot boundary and intervening changes are reconciled. A
   partial bulk load, filtered result or missing delta entry never proves removal.
   Preserve bounded tombstones/history separately from the current set. Conflicts
   require explicit status and budgeted recovery, not a per-ID request burst.

If the required delta lower bound, including overlap, exceeds the 24-hour lookback,
or the live baseline/continuity cannot be verified, retain the last usable generation
as stale/incomplete and rebase when permitted. A failed replacement alone leaves
the verified live generation usable; continue its deltas when budget permits.
When a replacement bridge fails and the live generation remains eligible for deltas,
discard that candidate and resume the live feed at the next allowed attempt. A
bootstrap candidate without a usable live baseline remains available for bridge
retry within the lookback window. Only a continuity failure in the live delta path
invalidates its checkpoint; replacement failures do not change that checkpoint.
Honor 429/503 backoff and `Retry-After`; retries consume budget.

Follow same-origin allowlisted content routes; never forward credentials to an
arbitrary redirect host. Preserve safe request IDs for diagnosis. An expired
content reference enters budget-aware recovery, not an unbounded download loop.

### Storage and query indexes

Index source IDs, qualified location associations and classifications per
generation. The airport tab and plate views share one airport result. PWA clients
download relevant subsets; retaining other records does not enable unqualified
geographic or route applicability queries.

Start with indexed reads. If repeated response serialization later warrants a
query-result cache, bound it and key entries by environment, generation, contract
version and canonical query. Generate current source-health/freshness metadata
and time-dependent validity separately so cached responses cannot freeze them.
Generation replacement invalidates derived selections, including cached empty
results. Dropping a derived response never drops source records or triggers FAA
acquisition. Errors and unknown coverage are never memoized as empty success.

Keep durable state outside the disposable weather cache. Partition it by source
environment and schema/adapter identity. One credential-level collector owns
ingestion; a local writer lock prevents duplicate writers on one host, and
deployment must enforce that ownership across hosts. A database is not required.

- **Budget journal:** durably reserve request class, attempt time and next allowed
  time before sending. Failed or interrupted attempts consume their slot. Persist
  this independently of dataset publication, with file/directory synchronization;
  restart, credential rotation and generation rollback cannot reset allowance.
- **Dataset generations:** commit records, indexes, watermark, freshness and a
  checksummed manifest atomically. Pin readers to a generation and retain the
  previous complete generation during construction. Bound retired generations,
  tombstones and spool files without evicting current notices.

Current hard limits are 64 MiB per bulk download, 32 MiB per delta, 512 MiB expanded
XML, 150,000 records, 2 MiB per XML member, depth 80 and 256 MiB per normalized
generation. Airport responses stop at 5,000 records or 16 MiB, returning unavailable
instead of truncating. One 60-second parsing worker handles each round. Measured
staging parsing fits that deadline; deployment headroom still needs qualification.
Keep current, the previous distinct dataset and one candidate generation, and retain
cancellation messages/tombstones for two days. The lock owner removes unreferenced
dataset files at startup and after publication/candidate disposal, including failed
replacement attempts. Cleanup never removes the admission journal. Empty, duplicate
or older-only deltas reuse the immutable record array, dataset file and airport
indexes; only the small manifest advances source time and watermark. Changed datasets
are written in bounded buffers.

On restore, validate the saved dataset's checksum before upgrading derived end kinds
and revisions from its retained source text/translations. Atomically republish its
manifest when an upgrade changes the content; retain source times, continuity and
quota history. The same validity interpretation applies to saved browser snapshots.
This avoids revision conflicts with unchanged source records after a normalizer fix.
Capacity accounting includes current, preceding and
replacement generations, raw text, indexes and temporary work. Insufficient
capacity rejects publication; it never justifies a truncated dataset. If admission
cannot be persisted, stop source requests. Corrupt/missing state needs conservative
recovery, not deletion and a new daily allowance. Provisioning, migration and backup
restoration must account for requests already made with the same credentials.

## Airport query contract

Use `GET`/`HEAD /api/notams/airports?faaId=…&icaoId=…`. Require at least one named
identifier and accept at most one of each. Both fields describe the same published
airport; trim and uppercase values, preserving their namespaces. Reject malformed,
oversized or duplicate parameters. Catalog `id`, map feature ID, generic `ident`
and NOTAM source ID are not airport-query identifiers.

The client owns the airport-to-alias relationship:

- Navigation supplies `faaId` and `icaoId` from one published airport feature.
  Reuse `airportIdentifiers` for normalization/deduplication while retaining the
  originating field's namespace; it is not an alias lookup service.
- Plates supplies those fields from the actual page's `ProcedureAirport`, together
  with catalog identity. Recover legacy selections through that exact catalog as
  described under [displayed page identity](#displayed-page-identity).
- Send both published IDs when available, including non-`K` ICAO codes. Never
  invent an alias, use a display ID as fallback, or combine IDs from different
  airport records. Missing/conflicting context produces matching unavailable.

The server unions exact matches against its qualified domestic-location and
ICAO-location indexes, deduplicating by source identity. Echo the normalized
selectors and each record's association evidence. A caller-supplied pair is not
proof of an alias relationship and never updates a global alias registry. Additional
associations require independently qualified source evidence. This keeps alias
ownership with the published airport data without adding a second navigation-feed
loader to the weather service.

Return versioned records, supported scope, environment, generation, source-check
time and continuity. Zero means no records for the supplied selectors in a verified
complete generation; absence from the NOTAM index does not prove that an airport
is unknown or invalid. The client must have resolved airport identity before
presenting that zero. This is location coverage, not complete route applicability.
If source fields cannot establish coverage for a supplied namespace, label that
query's association coverage incomplete; an unmatched ICAO-only query must not
imply zero airport notices when relevant records may carry only domestic IDs.
If pagination is needed, pin every page to one generation and expose incomplete
counts until all pages arrive.

Disabled collection or no usable baseline returns 503 with a stable reason code
and appropriate retry hint. Verified saved data can return 200 with explicit stale/
incomplete state. Reads, cache misses and user retries never start NMS acquisition.
Response metadata stays in the body, independently of weather-specific headers.

Expose feed status at `/api/notams/healthz`: enabled/environment, generation,
continuity, source check, last completed full reconciliation, latest delta boundary,
record counts, safe failure code and next allowed attempt. Keep process health,
freshness and completeness separate; a successful full sync cannot conceal later
failed deltas. Health output excludes credentials and temporary content references.

## Info server integration

Use `createInfoServer`, `info:serve`, `info:build` and `zlayer-info.service` for the
shared listener on port 8787. The [server guide](../../../tools/info-server/README.md)
owns common operations; this section defines the wiring for the collection
and query contracts above. No additional workspace or service framework is needed.

### Module and lifecycle boundaries

The explicitly composed `createNotamService` runs beside the existing weather
updaters. A small surface is sufficient: `restore`, `refresh`, `readAirport`,
`status`, and `close`. Use typed constructor options with injectable transport,
clock and cancellation for tests. Environment and credential-file loading belong
in `main.ts`, not in parsers or request handlers.

| Module | Responsibility |
| --- | --- |
| `tools/info-server/notams/service.ts` | Single ingestion owner, admission, bootstrap/delta/recovery state, query indexes and lifecycle |
| `tools/info-server/notams/client.ts` | OAuth renewal, allowlisted NMS requests, bounded downloads and source error classification |
| `tools/info-server/notams/store.ts` | Durable quota journal, checksummed dataset generations and atomic publication |
| `tools/info-server/notams/lock.ts` | Kernel-backed single-writer lifetime lock |
| `tools/info-server/notams/normalize.ts` | Namespace-aware AIXM/source normalization, identity and lifecycle validation |
| `tools/info-server/notams/routes.ts` | Strict local route parsing and snapshot responses |
| `packages/contracts/src/` | Versioned NOTAM delivery types and guards, following the package's existing layout |

The server normalizes source facts; flairs and plate matching remain plugin
derivations. Keep React/workspace state out of the backend, and secrets/filesystem
paths out of shared delivery types. Split further modules only for distinct work.

Wire lifecycle into `server.ts` as follows:

1. Construct with the shutdown signal and restore local state independently.
   Report NOTAM loading until ready; weather startup never waits for FAA access
   or NMS recovery.
2. Let the existing 30-second update tick call a cheap, nonblocking
   `notams.refresh()`, enforcing the [sync policy](#sync-policy) with one in-flight
   round and no queued catch-up. Preserve `startUpdates: false` for tests.
3. Serve published generations through the [query contract](#airport-query-contract).
   A browser abort cancels its response, not shared ingestion.
4. In idempotent `close()`, stop admission, abort transport/parsing and drain
   bounded durable writes before releasing the lock, within the shutdown deadline.

NMS failures affect only NOTAM readiness. Sanitize errors before the server's
generic logger: safe codes and permitted request IDs only, excluding tokens,
credentials, content URLs and upstream bodies. Recovery stays within the service
rather than restarting the weather process.

### Reuse and resource isolation

Reuse HTTP methods, exact-origin CORS, `no-store`, security headers, compression,
cancellation and bounded worker patterns through small helpers as needed. Keep
weather's `Resource`, `PreparedFamily`, route classification and `WeatherCache`
unchanged in ownership; NOTAM reads never enter `cache.get()`. `UpstreamQueue` is
in-memory admission and cannot replace the durable budget journal. NMS owns its
queue and does not inherit weather's test `spacing` override.

Bulk decompression/XML normalization runs in one cancellable parsing worker;
credentials remain in the parent, which passes private spool paths. The build
emits that worker beside the server bundle. The parent streams normalized records,
merges revisions, builds indexes and publishes generations with asynchronous file
writes. Merge, sorting, hashing and serialization still consume parent event-loop
time. Combined weather/NMS load measurements must qualify that work before
deployment; move generation construction into the worker if latency requires it.
The 60-second worker deadline handled the measured staging load, but needs
deployment headroom qualification.

Measure weather latency and preparation during bootstrap, deltas and NMS failure.
The systemd budget is shared: four CPUs' worth of time and 2 GiB across the process
and workers. Set the [storage/resource limits](#storage-and-query-indexes) within
measured headroom; adding a worker does not add memory capacity.

### Configuration and credentials

`main.ts` loads these server-only settings:

| Setting | Meaning |
| --- | --- |
| `NOTAMS_ENABLED` | Defaults to false; explicit collection enablement |
| `NOTAMS_ENVIRONMENT` | Required when enabled: `staging` or `production`, selecting fixed data/auth hosts |
| `NOTAMS_STATE_DIR` | Dedicated durable directory; local default `.cache/notams`, deployed outside the weather cache |
| `NOTAMS_CLIENT_ID_FILE` | Private file containing the FAA workbook's Key, used as OAuth client ID |
| `NOTAMS_CLIENT_SECRET_FILE` | Private file containing the FAA workbook's Secret |

Use an optional systemd `LoadCredential` drop-in or Docker read-only secret mounts.
Disabled deployments need neither file. Never put secrets in `VITE_*`, checked-in
configuration, command arguments or image layers; access tokens stay in memory.
Invalid enabled configuration reports NOTAM unavailable while weather continues.
Deployment acceptance checks product readiness, not only process health.
Enabled collection requires Linux `flock` (util-linux); Docker installs it. A
kernel-owned helper lock is held until collector shutdown, so a process crash
does not leave a stale PID lease. The credential-level single-owner rule also
applies across hosts. Never delete `budget.json` or the provisioning marker to
recover data: missing/corrupt budget state blocks source requests. Corrupt dataset
generations can rebase under the existing budget; a previous readable generation
is retained as incomplete. Source conflicts persist that incomplete state.

### HTTP, proxy and deployment changes

Dispatch `/api/notams/` before weather's `routeFor`, enforcing the query contract
and rejecting unexpected parameters/ranges. Expose no arbitrary upstream proxy.
Include the feed-health summary as `notams` in existing `/api/weather/healthz`.

- Add `/api/notams/` to `tools/dev-proxy.ts` with the same
  `INFO_API_ORIGIN` target as weather. Both products use one local/remote service.
- Add a sibling location in `docs/development/info-api.nginx.conf` forwarding
  to proxy-host loopback port 8788. Use an SSH tunnel to backend port 8787 and
  the existing same-origin TLS boundary; no additional public listener is needed.
- Give `zlayer-info.service` a second persistent state directory,
  `/var/lib/zlayer-notams`, and configure `NOTAMS_STATE_DIR` there. Keep it stable
  across release symlinks and weather cache swaps. Mount a separate persistent
  NOTAM volume for Docker and include any new worker in the existing build.
- Warm candidate weather releases with NMS disabled. Stop and drain the old
  collector before enabling its replacement against the same durable NOTAM state.
  Do not let candidate/staging processes use the production key concurrently.
  Validate state-schema compatibility before switching or rolling back code;
  never restore an older quota journal as part of rollback.

Multi-host expansion needs a shared admission mechanism or continued single-owner
ingestion before adding collectors.

## Normalized records

Define and validate a versioned delivery contract before integrating UI. Source
facts cross that boundary; the derivation row describes client-owned results built
from those facts, not precomputed server UI or plate matches:

| Area | Retained meaning |
| --- | --- |
| Identity | Opaque source ID, original ID, classification, number/year/series, environment, and record revision/digest |
| Association | Location, ICAO ID, accountability, affected FIR, airport/facility references and evidence for derived associations |
| Lifecycle | Issued/updated times, replacement/cancellation information and references, preserving unknown values |
| Validity | Original and normalized start/end, estimated/permanent/unknown end kind, raw schedule and supported evaluation |
| Content | Local/ICAO translations, body, structured event/subject fields, and source-part relationships |
| Derivation | Parser version, subjects/effects, clauses, targets, unresolved interpretation, and field/text-span evidence |
| Coverage | Generation, source-check time, continuity, supported scope and processing limitations |

Keep IDs as strings: 16 digits can exceed JavaScript's safe integer range. Display
numbers alone are not durable keys. Preserve unknown enum values and source fields
needed to explain results. Validate records before application state or storage.

A safely preserved record with unsupported interpretation stays readable/raw and
unresolved. A broken envelope, truncated load, unidentifiable record or unprocessable
lifecycle update cannot be silently discarded while claiming a complete generation.
Retain the prior snapshot and expose the limitation. Optional invalid geometry
must not hide otherwise valid text.

Separate source-check, issue/update, effective and browser retrieval times. Missing
fields cannot manufacture freshness. Matching cache identity includes generation,
parser/matcher version, airport, and exact plate/catalog context.

## Parsing and flairs

Use deterministic bounded parsing backed by fixtures: source normalization,
lexical/header parsing, scoped clauses/targets, then presentation. Keep comparison
text alongside untouched raw text. Prefer qualified structured fields; use supported
grammar where absent. Surface conflicts instead of silently choosing one reading.

Recognize keywords in their subject position, not unrestricted substring searches.
Start with NMS's vocabulary: `RWY`, `TWY`, `APRON`, `AD`, `OBST`, `NAV`, `COM`, `SVC`,
`AIRSPACE`, `ODP`, `SID`, `STAR`, `CHART`, `DATA`, `DVA`, `IAP`, `VFP`, `ROUTE`,
`SPECIAL`, `SECURITY`. Preserve unknowns. A D pointer mentioning an FDC notice keeps
its original classification.

Attach effects to their subject and clause. Retain exceptions, conditions, aircraft
categories, transitions and time windows. Context-specific abbreviation expansion
must preserve values, units, direction and scope. Unknown clauses stay in the
default readable body; raw disclosure is not a reason to omit qualifications there.
Every derived flair retains supporting source-field or text-span evidence.

The current grammar includes the D/FDC clause forms observed in the KSJC staging
snapshot: runway/taxiway/apron closures, runway and approach lighting outages,
ILS and other named navaid outages, obstacle light outages, cranes, UAS Activity
and explicit surface-to-AGL limits. Procedure tags include the source procedure
title, amended DA/MDA and visibility minima, sidestep/circling minima, VDP changes,
takeoff minima and climb gradients, terminal-route/transition restrictions, and
conditional inoperative-lighting notes. Numeric minima, aircraft categories and
their qualifications remain together in the complete body; tags do not replace
them with a single airport-wide value. A `FOR INOP ALS` note does not establish an
actual lighting outage, and an obstacle or lighting notice does not close a runway.

Color expresses the kind of information, independently of D/FDC classification:

| Color | Meaning | Examples |
| --- | --- | --- |
| Blue | Facility or subject | Runway, RWY 12R, Navigation, Obstruction |
| Purple | Procedure identity | Approach, Departure, RNAV (RNP) Z RWY 30L |
| Amber | Restriction, amendment, outage, activity or uncertainty | Minima Amended, ILS Unavailable, UAS Activity, Check Schedule |
| Red | Explicit closure of the identified facility | Runway Closed, Taxilane Closed |
| Neutral | Supporting information or timing | Flagged and Lighted, Surface to 300 ft AGL, Upcoming |

Use the shared `surface-tag-*` / `text-tag-*` theme roles; the light palette is
generated from the dark seeds. Labels convey the meaning without color and wrap
within narrow cards. Authored flair labels use title case, preserving aviation
abbreviations, source procedure titles and unit symbols such as `ft`. Each tag's
title exposes its supporting source text. The same
entry component renders airport lists and expanded plate notices.

Illustrative fixtures, not live NOTAMs:

| Fragment | Result |
| --- | --- |
| `RWY 20 RWY END ID LGT U/S` | Runway / Lighting Unavailable; no runway-closure claim |
| `RWY 09/27 CLSD EXC …` | Runway closure with the exception retained |
| `IAP … CIRCLING NA` | Circling Unavailable for that procedure, not the entire approach |
| `SID … TRANSITION … NA` | Restriction scoped to that transition |
| `SEE FDC …` | Pointer with a reference when resolvable; unresolved pointers stay visible |

Parsing is bounded to 64 KiB of body text, 320-character heading prefixes, 16
procedure targets and 20 deduplicated flairs. Scan amendment delimiters before
applying the bounded heading grammar. If limits are reached, retain the entire
body/raw text and flag **Interpretation Limited**. Derived results are cached by
record identity for repeated airport-list and plate matching; replacement records
are parsed anew. Parser version 3 owns these derivations, not the wire schema.

Parse supported UTC validity forms and preserve `EST`/`PERM`/unknown-end meaning.
Check the source body and every retained translation for compact validity ranges,
including ranges before multipart footers. An `EST` range must agree with the
structured end to the published minute; conflicting evidence stays unknown. Estimated
and unknown ends remain visible for review after the stated end. Only a fixed end
can remove a notice from the current/upcoming display.
Permanent notices do not get an invented expiry. Distinguish the effective interval
from recurring schedules, including overnight/day-boundary cases. Unsupported
schedules get **Check Schedule**, not a guessed Active/Inactive result. Retain
schedule text even after successful evaluation. Qualify estimated-end behavior
and cancellation precedence before enabling time-based removal rules.
The NMS form `Daily:1500-0500~DLY 1500-0500` is evaluated only when the two windows
agree. Conflicting windows and sunrise/sunset schedules remain **Check Schedule**.

Only verified part identifiers establish multipart groups; retain each part's raw
source and expose missing parts. Cross-format translations are representations of
one record, not additional independent notices.

## Procedure matching

Matcher version 3 is a pure function of validated notices and exact plate context. Return
source ID, applicability outcome, affected clauses, and an explainable reason.
Avoid numerical confidence scores suggesting unmeasured accuracy.

1. Resolve airports through published FAA/ICAO aliases and qualified associations.
   Never manufacture IDs by adding/removing `K`, equate accountability with the
   airport, or assign a nearby coordinate to it.
2. Resolve class and procedure identity from the displayed edition's catalog.
   Use publisher IDs/computer codes and established name aliases. IDs from
   different systems need a proven mapping.
3. Normalize punctuation, whitespace, runway zero-padding and supported SID/STAR
   number-word/code aliases. Preserve subtype, Y/Z, L/R/C, revision numbers,
   `HI-`, helicopter/special qualifiers and transitions. GPS and RNP remain distinct.
   Combined ILS/LOC titles match either named branch, retaining its own variant and
   subtype: `ILS Z OR LOC Z` matches ILS Z and LOC Z, while `ILS OR LOC Z` matches
   unlettered ILS and LOC Z. Qualifiers and runway sides apply to both branches.
   Unsupported heading prefixes remain unresolved rather than becoming a recognized
   ILS/LOC/RNAV suffix.
4. Handle multiple named procedures and explicit broad scopes such as all IAPs at
   an airport. A runway in an exception, missed approach, or obstacle narrative
   is not by itself a procedure target.
   Broad clauses with exclusions or conditions, such as `ALL IAPS EXCEPT`, require
   review for every candidate plate; an excluded title never becomes an applies match.
5. Compare amendment number/date with the displayed plate. A mismatch requires
   review when the target otherwise agrees; it alone does not prove incorporation.
6. Include D runway/facility notices when explicit runway identity or a qualified
   dependency proves relevance. Preserve their actual effects without inventing
   minima or declaring whole procedures unavailable. Incomplete dependencies must
   not imply complete facility coverage.
   Explicit `NAV ILS/LOC RWY … U/S` matches ILS or LOC approaches on that exact runway;
   `GP`/`GS` matches ILS approaches. These notices do not establish a dependency for
   RNAV approaches. Unknown or absent facility/runway dependencies remain unresolved,
   and unresolved interpretation also qualifies the collapsed bar's assurance.

| Outcome | Presentation |
| --- | --- |
| Applies to this plate | Unambiguous procedure/broad-scope match or proven runway/facility relationship; show reason and affected scope |
| Review applicability | Plausible association with missing context, ambiguous wording or amendment mismatch; uncertainty stays visible |
| No established match | Keep the notice in airport results; do not attach it to an unrelated plate |

Clearly incompatible runway sides or variants are not review candidates merely
because they share a substring. Conversely, unresolved airport procedure notices
cannot disappear into a false zero-match assurance: expose unresolved procedure
coverage and access to the full airport list. Matching is not a claim that every
operationally applicable notice has been found.

## Client lifecycle and offline behavior

One stable client per workspace combines demand from airport NOTAM bodies, visible
Plates lists, and open plate bars. Coalesce the same airport; allow different detail
and reader airports concurrently. A collapsed bar still needs count/freshness
updates while visible. Stowed/hidden consumers retain state but release demand.

Use core `requestJson`, `OnDemandRefresh`, connectivity observation and scoped
storage. Refresh demanded snapshots on the three-minute product cadence; qualify
immediate reopen/reconnect reads against existing freshness. Browser reads never
change upstream cadence. Reopening or adding another airport preserves each
airport's next due read; the shared scheduler wakes at the earliest deadline.
Only completed reads establish throttling, so unloading during acquisition cannot
delay the first read after reactivation. Dispose timers/listeners and reject obsolete airport,
edition, page or activation completions.

Persist bounded validated airport snapshots. The client keeps up to 24 airport
entries under a 64 MiB eviction target, protecting visible demand; the optional
scoped record is capped at 2 MiB and skips snapshots that do not fit.
Restoration shows saved results but
cannot replace newer live state. Preserve original check/validity times and usable
data after refresh failure. Optional storage failure does not invalidate online
results. Re-evaluate validity/schedules over time even offline; handle clock rollback
and implausibly future timestamps.

Keep transport, source continuity and freshness separate. **Freshness policy:**
two missed three-minute checks mark data stale (six minutes since the last
successful source check). This implemented product threshold still needs
operational qualification. Offline remains explicit even within that interval.
Freshness does not establish
completeness, and neither is a regulatory guarantee.

PDF and NOTAM offline availability are separate facts. Saving a plate/region does
not promise current NOTAMs. Keep the existing PDF save indicator specific to the
document, and NOTAM status in its bar/list. Verified regional NOTAM packages and
route packing remain future work.

## Implementation sequence

The collector, parser/matcher and UI stages are implemented locally. Basic staging
authentication, complete-load parsing and delta cancellation behavior were exercised
as recorded above. The table retains acceptance targets: it does not imply every
source variant, device or production deployment is qualified.

| Stage | Deliverable and acceptance |
| --- | --- |
| 1. Qualify NMS | Staging auth and required endpoints within budget; sanitized D/FDC, lifecycle, schedule, multipart and complete-load fixtures; resolve continuity/identity questions and set measured limits |
| 2. Collector and contract | Integrate the NMS module into the existing weather process; full local dataset, daily reconciliation, three-minute deltas, shared guards/types, durable quota/generations, local airport reads, health, secrets and proxy wiring; prove restart, gap recovery and weather isolation |
| 3. Parser and matcher | Pure derivation with evidence and exact edition/page context; representative positive and negative catalog matches |
| 4. Airport tab | Registration, Info/Plates/NOTAM composition and persistence compatibility, core UI, both classifications/raw text, and offline/failure behavior |
| 5. Plate integration | Actual-page context, row counts and scrolling red disclosure; preserve PDF lifecycle and optional-provider cleanup |
| 6. Release qualification | Full local checks, reference/device review, comparisons with matching source times/scope, production onboarding and deployment readiness |

Stages 1 and 6 remain open for the source/operational questions below and the
broader release matrix. No production collection is enabled by this implementation.

Implementation homes are `plugin.ts`, `public.ts`, client/storage, pure parser/matcher,
and entry/airport/plate UI under this directory. Create modules only for distinct
responsibilities. The [server module map](#module-and-lifecycle-boundaries) defines
backend ownership; wire types/guards belong in `packages/contracts`.

Update Navigation/Plates guides as integrations land and shared data/persistence,
source, architecture, gateway and deployment guides for their owned contracts.
Link here for parsing/matching rather than duplicating rules. Keep future status
in the roadmap and dated validation evidence beside this plugin with source/build/
time limitations. This README remains the canonical guide after implementation.

## Verification

### Local implementation evidence — 2026-10-04

- `node --import=tsx --import=./test/helpers/assets.ts --test test/notams.test.ts test/notams-server.test.ts`:
  15 tests passed at the initial implementation baseline. Coverage includes observed AIXM variants, conservative flairs,
  procedure identity, schedules, actual-page context, client lifetime, durable
  admission/recovery, bulk-to-delta publication and weather HTTP isolation.
- Parser version 2 follow-up: 11 NOTAM unit tests and three theme tests passed.
  Fixtures cover KSJC-style minima, lighting/navaid outages, obstacle/UAS notices,
  closure scope, conditional lighting notes, bounded headings and NMS daily schedules.
  Replaying the saved KSJC staging airport response derived specific tags for all
  30 D/FDC records; this checks source forms, not operational completeness.
- `test/e2e/notams.spec.ts`: five Chromium tests passed in the existing Playwright
  container. They exercised the third tab and filters/raw disclosure, optional
  providers, shared requests, page changes without PDF reacquisition, offline
  freshness, stowed demand and the narrow scrolling bar/expand-collapse interaction, plus
  distinct flair colors and at least 4.5:1 text contrast in both themes on a phone.
  These use invented notices and a synthetic three-page PDF.
- `npx tsc --noEmit`, `npm run check:imports`, `npm run build`, and
  `npm run info:build` passed. Import checking covered 578 source modules.
- Parser version 3 / matcher version 2 review fixes: 29 focused NOTAM tests passed,
  covering translated/multipart estimated ends, saved-record migration and revision
  reconciliation, `HI-` identity, explicit navigation outages, qualified broad
  scopes, live recovery after failed replacement syncs, candidate cleanup and
  unchanged-delta file reuse. Seven NOTAM Chromium tests passed in the matching
  Playwright container, including catalog retry/reconnect without replacing the PDF.
  TypeScript, import boundaries (579 modules), and the info-server build passed.
  These runs used fixture source responses; they did not spend FAA quota or change
  the live collector's state. The host browser lacked its GLib dependency, so the
  browser run used the already installed container image with networking disabled.
- Live staging full-load and delta evidence is recorded in the source qualification
  section above. Production was not enabled, and temporary plaintext credential
  copies used for this exercise were removed; durable admission state is retained.

The full verification suite was not run, following the implementation request to
avoid unrelated tests/full verification. These results do not complete the broader
release matrix below or qualify shared deployment capacity.

### Release qualification matrix

Parser/matcher fixtures must cover D/FDC, unknown fields/keywords, whitespace, multiple
procedures, runway suffixes, RNAV Y/Z and GPS/RNP, ILS/LOC combined titles,
SID/STAR revisions/transitions/continuations, amendment mismatches, broad scopes,
pointers, multipart gaps, scoped `NA`/`U/S`/`CLSD`, exceptions, and failed parsing
that retains readable/raw text. Include incidental runway/procedure mentions as
negative cases, plus supported/unsupported schedules and UTC boundaries.

Collector tests must cover token expiry/renewal failure, 200-with-errors, redirect/path
forms, expired content, malformed/truncated/oversized compressed/XML responses,
empty/overlapping deltas, out-of-order revisions, duplicate IDs, cancellations/
replacements, clock skew, persisted quota, corrupt checkpoints, partial writes,
concurrent readers, and outages beyond lookback. Rebase/checklist comparisons
require established completeness and permitted request cadence.

Full-dataset tests must cover previously unqueried airports, every delivered
classification, upcoming notices, cancellations missing from an earlier faulty
generation, older bulk snapshots, changes during reconciliation and incomplete
bulk loads. Prove that a reconciled full sync repairs drift without regressing
newer records; that partial loads/capacity failures retain the preceding dataset;
and that full pulls, deltas, failures and restart share the same durable budget.
Query-cache eviction and generation changes must preserve local coverage and
invalidate obsolete empty results without source calls.

Server integration tests use fake NMS transport, clocks and temporary state. Prove
that many airport/health reads and disconnected clients cause no FAA requests;
that disabled/misconfigured NMS, failed OAuth, corrupt state and parsing failure
leave weather routes available; and that restart, overlapping refresh calls,
shutdown, credential rotation and release handoff preserve request admission.
Exercise `GET`/`HEAD`, strict routing, safe errors, no-baseline versus complete
empty results, generation-pinned reads, and cold/warm state with the weather
cache independently replaced. Validate proxy paths and the built worker layout.
Cover FAA-only, ICAO-only and paired selectors, non-`K` aliases, catalog-ID rejection,
duplicate records across selectors, conflicting airport context and complete zero
results for valid airports without notices. Query input never creates alias mappings.
Run a combined bootstrap/forecast workload within the deployed CPU/memory limits
before production enablement; normal unit passes do not establish that capacity.

Browser regressions must cover third-tab keyboard order, airports without plates,
saved-tab compatibility, disabled providers, simultaneous airport contexts, raw
disclosures, filters, stale/empty/error states, denied storage, reconnect and late
results. Plate regressions cover paging across airports, continuations, ambiguous
context, saved old editions, fullscreen, rotation, short/narrow viewports, enlarged
text, touch scroll, focus, and unchanged PDF acquisition/worker/view state.

Use the [shared UI viewport matrix](../../../docs/features/shared-ui.md) and
[local verification commands](../../../docs/development/local-development.md#verification).
Run `npm run verify:full` before committing. Installed-device and
production-feed checks remain separate. A fixture pass or ForeFlight comparison
does not prove operational completeness. Comparisons record airport, exact plate
edition/page, environment, effective time, source-check time and supported scope.

## Open source questions

These are qualification work, not assumptions to hide in the UI:

1. Confirm production entitlement, redistribution conditions, and how auth,
   content, checklist, location-series, diagnostics and failed calls consume the
   credential budget, including whether classification bulk limits aggregate.
2. Confirm 24-hour lookback, location-series defaults, delta inclusivity, source
   clocks/baseline timestamps and a gap-free bootstrap sequence.
3. Establish cancellation/replacement IDs and revision ordering, estimated/permanent
   end behavior, and same-time conflicts with authoritative fixtures.
4. Confirm completeness indicators, record limits/pagination, bulk counts, and
   malformed-record behavior in response envelopes.
5. Validate FDC airport association, multi-airport/multipart records, dependency
   coverage, and location/geometry limits for ARTCC/regional notices.
6. Qualify procedure/amendment name variation, schedules, translation availability,
   safe record sizes and supported content URL forms.

## References

- The onboarding inventory and discrepancies above preserve source context without
  requiring credential-bearing files to be published with this guide.
- [FAA AIM, NOTAM classifications and keywords](https://www.faa.gov/air_traffic/publications/ATpubs/AIM_html/chap5_section_1.html)
  supplies terminology/examples; interpretation still needs qualified NMS fixtures.
- [ForeFlight FDC NOTAM display](https://support.foreflight.com/hc/en-us/articles/203329009-Where-can-FDC-NOTAMs-be-viewed-in-ForeFlight-Mobile)
  describes airport lists, the red plate alert, and access to all airport notices.
- [ForeFlight 17.8](https://www.foreflight.com/releases/17-8) describes relevant
  procedure counts and Show All. These are interaction references, not documentation
  of ForeFlight's matching algorithm.
- [ForeFlight NOTAM interface improvements](https://www.foreflight.com/enhancements/notam-interface-improvements)
  provides the list/filter reference. The flair grammar and theme colors above are
  this plugin's own deterministic presentation rules.
- [Navigation](../navigation/README.md), [Plates](../plates/README.md),
  [shared UI](../../../docs/features/shared-ui.md#shared-controls),
  [time formats](../../../docs/features/date-time-display.md), and
  [workspace persistence](../../../docs/architecture/workspace-persistence.md)
  own existing host contracts.
