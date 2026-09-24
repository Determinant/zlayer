# Navigation

[Documentation](../../../docs/README.md) / Plugins / navigation

The [core plugin bridge](../../../docs/architecture/layer-plugins.md#inter-plugin-communication)
exposes airport data and visibility to optional consumers such as weather. National
navigation data readers remain usable independently of this plugin’s enablement.

This plugin owns FAA airport, NAVAID, fix and VFR-waypoint data, airway loading,
search, airport/runway/frequency details, map symbols and navaid identification.
Search and route resolution retain access to navigation data independently of
background map visibility. Weather observations belong to the
[METAR/TAF plugin](../metar-taf/README.md); route editing and procedure selection
belong to [Routes](../routes/README.md).

## Source entry points

| Entry | Responsibility |
| --- | --- |
| [plugin.tsx](plugin.tsx) | Preferences, controls and navigation/inspection/identification map contributions |
| [api.ts](api.ts) | Data-only navigation and airway loading, validation, resource identity and regional views |
| [use-data.ts](use-data.ts), [use-search.ts](use-search.ts) | Visible-data loading and search orchestration |
| [map.ts](map.ts), [layer.ts](layer.ts), [renderer.ts](renderer.ts) | Map resource lifecycle and rendering |
| [detail-card.tsx](detail-card.tsx), [airport-runways.tsx](airport-runways.tsx), [airport-frequencies.ts](airport-frequencies.ts) | Feature details and airport metadata |
| [fix-display.ts](fix-display.ts), [symbols.ts](symbols.ts), [identification-layer.ts](identification-layer.ts) | Fix classification, symbology and navaid-identification rendering |

## Behavior, contracts and verification

- Selected features use core's `DetailPanel`, shared with weather advisories, for
  their frame, heading/close controls, metadata styling and scroll body. Navigation
  retains its actions, Info/Plates tabs, content and refresh demand.
- Airport Info/Plates uses core's [content tabs](../../../docs/features/shared-ui.md#shared-controls),
  including selected-state semantics and Left/Right/Home/End navigation. Selection
  remains plugin-persisted. Inactive panel shells stay empty; selecting another tab
  or identification unmounts the previous body, while stowing retains it.
- [Fix display](fix-display.md) owns classification, zoom/density rules, route/selection
  context and its real-map verification fixture.
- [Feature contracts](../../../docs/data/contracts.md#feature) and
  [runway metadata](../../../docs/data/contracts.md#airport-runway-details-and-wind-components)
  define identities, raw fields, units and cross-plugin wind calculations.
- [Resource identity and recovery](../../../docs/development/engineering.md#recovery-and-source-identity)
  apply to loaders; [offline storage](../../../docs/features/offline-storage.md#navigation-open-details-and-recovery)
  defines saved-edition ownership, partial-source failures and open-view repair.
- [Local verification](../../../docs/development/local-development.md#verification)
  covers repository checks; [graphics checks](../../../docs/verification/graphics-compatibility.md#run-the-checks)
  cover the rendered symbols and map behavior.
