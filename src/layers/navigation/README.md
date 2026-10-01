# Navigation

[Documentation](../../../docs/README.md) / Plugins / navigation

The [core plugin bridge](../../../docs/architecture/layer-plugins.md#inter-plugin-communication)
exposes airport data and visibility to optional consumers such as weather. National
navigation data readers remain usable independently of this plugin’s enablement.

This plugin owns FAA airport, NAVAID, fix and VFR-waypoint data, airway loading,
search, airport/runway/frequency details, map symbols and navaid identification.
With navigation manifest schema 3, IFR fixes and VFR waypoints share the publisher's
`fixes` file. Each view filters by `properties.kind`; the manifest supplies the VFR
count, and the parsed source is shared in memory.
Search and route resolution retain access to navigation data independently of
background map visibility. Weather observations belong to the
[METAR/TAF plugin](../metar-taf/README.md); route editing and procedure selection
belong to [Routes](../routes/README.md).

## Source entry points

| Entry | Responsibility |
| --- | --- |
| [plugin.tsx](plugin.tsx) | Preferences, controls and navigation/inspection/identification map contributions |
| [api.ts](api.ts) | Data-only navigation and airway loading, validation, resource identity and regional views |
| [data.ts](data.ts) | Shared station-alignment supplementation for ID and route identification, restricted to the selected FAA cycle and exact station identity |
| [use-data.ts](use-data.ts), [use-search.ts](use-search.ts) | Visible-data loading and search orchestration |
| [map.ts](map.ts), [layer.ts](layer.ts), [renderer.ts](renderer.ts) | Map resource lifecycle and rendering |
| [detail-card.tsx](detail-card.tsx), [airport-runways.tsx](airport-runways.tsx), [airport-frequencies.ts](airport-frequencies.ts) | Feature details and airport metadata |
| [fix-display.ts](fix-display.ts), [symbols.ts](symbols.ts), [identification-layer.ts](identification-layer.ts) | Fix classification, symbology and navaid-identification rendering |

## Interaction efficiency

Search ranks navigation independently of weather and enriches only the returned
airport matches. Observation updates cannot rescore national navigation data.
Navaid identification skips unchanged projected geometry and allows one source
submission at a time; subsequent movement uses the latest camera after acceptance.
Source errors invalidate visual reuse, including when MapLibre resolves the failed
submission; the next input or camera update can retry unchanged geometry.
Unmounting removes the error listener and invalidates pending completions.
Geographic connections and projected label placement retain their existing meaning
through camera movement.

## Airport frequencies

Info leads with elevation and longest runway, then groups radio services in this
order: weather broadcasts (ATIS/D-ATIS/AWOS/ASOS), **CD** (clearance delivery),
**Ground**, **Tower / CTAF**, **Approach**, **App / Dep** (a published combined
service), **Departure**, and **Center**. Missing services are omitted. Tower and CTAF combine
only when their displayed channels, facilities, sectors and secondary status match;
otherwise they stay separate.
Separate and combined approach/departure records retain their published roles.
The publisher keeps legacy services in `frequencies[]` and adds the new services
in optional `terminalFrequencies[]`. Center records use optional `centerFrequencies[]`
so clients that already validate the terminal service enum remain compatible.
Info combines all three lists for display; older PWAs ignore unknown extensions.

Terminal and Center channels show their servicing facility's published radio call
or name beside the frequency (for example, SOCAL, NORCAL or OAKLAND). A facility
identifier is the fallback when its name is unavailable. When distinct providers
share a published name, append their identifiers to keep both entries identifiable.
Names remain associated
with each channel and its notes, including equal frequencies served by different
facilities. Center rows retain the published altitude/sector, and their disclosures
include the RCAG site/use and remarks. Only Center frequencies explicitly associated
with the airport are included; proximity and the airport's responsible Center do
not establish a frequency assignment. The publisher resolves provider names from
its own facility records; an airport's primary approach call can name a different
facility and must not be reused blindly for secondary services or Center channels.

Summaries and expanded notes share structured channel data and the same number,
unit and context renderer; display strings are never parsed back into fields.
Within each service, VHF channels lead and primary channels precede secondary channels, with published
sectors and secondary status visible beside each channel. Precision is retained
to three decimal places. Each service's chevron opens its remarks, qualified uses
(including Tower/Ground `IC`, pre-taxi clearance and weather subtypes), and additional UHF channels. Notes for multiple
channels, including a single VHF channel with additional UHF alternatives, retain
their frequency, sector and secondary status so restrictions stay
associated with the correct channel. Combined Tower / CTAF notes label each channel’s
service explicitly. UHF-only services remain visible in the summary.
FAA `TOWER_HRS` is labeled **Tower hours** only under Tower; it is not a schedule
for the other services. A schedule shared by every Tower record appears once;
conflicting or partially missing schedules stay attached to their channels.
The [frequency contract](../../../docs/data/contracts.md#feature)
defines source identity, supported types and compatibility with older exports.

`test/feature-details.test.ts` covers service ordering, precision and note attribution;
`test/e2e/airport-summary.spec.ts` covers map/search selection, disclosures, responsive
layout and offline restoration.

## Behavior, contracts and verification

- Selected features use core's `DetailPanel`, shared with weather advisories, for
  their frame, heading/close controls, metadata styling and scroll body. Navigation
  retains its actions, Info/Plates tabs, content and refresh demand.
- Airport Info/Plates uses core's [content tabs](../../../docs/features/shared-ui.md#shared-controls),
  including selected-state semantics and Left/Right/Home/End navigation. Selection
  remains plugin-persisted for the 128 most recently written feature-tab identities.
  Older optional tab preferences are evicted; feature selection is unaffected. Inactive panel shells stay empty; selecting another tab
  or identification unmounts the previous body, while stowing retains it.
- [Fix display](fix-display.md) owns classification, zoom/density rules, route/selection
  context and its real-map verification fixture.
- Route points show Name/GPS choices above the ID table. Station names in the
  existing sorted table select radial/distance identification and mark the selected
  row. Each button has two rows: identifier/checkmark/MON, then frequency/type,
  fitting the 44px target even on narrow phones. Station actions use core `ui-button` states and touch sizing; table values
  use 14px type, supporting labels 12px, and MON badges at least 11px. Missing
  magnetic alignment disables selection while keeping TB visible.
  The selected radial reference is always drawn alongside the top-three map
  references, with blue dashes and yellow line/marker/label trim. Saved references
  retain their snapshot position even without current station data. The selected
  table button and map key use matching yellow trim. Typed named references need
  not appear in the nearby list; true bearings show TB. Reference lines follow
  sampled great-circle paths with midpoint labels aligned to the local direction.
  The route chip’s **Identify point…** action opens this same ID panel. Routes owns
  the saved descriptions and explicit nearby-point replacements; see [route point identification](../routes/README.md#alternative-point-identification).
- [Feature contracts](../../../docs/data/contracts.md#feature) and
  [runway metadata](../../../docs/data/contracts.md#airport-runway-details-and-wind-components)
  define identities, raw fields, units and cross-plugin wind calculations.
- [Resource identity and recovery](../../../docs/development/engineering.md#recovery-and-source-identity)
  apply to loaders; [offline storage](../../../docs/features/offline-storage.md#navigation-open-details-and-recovery)
  defines saved-edition ownership, partial-source failures and open-view repair.
- [Local verification](../../../docs/development/local-development.md#verification)
  covers repository checks; [graphics checks](../../../docs/verification/graphics-compatibility.md#run-the-checks)
  cover the rendered symbols and map behavior.
