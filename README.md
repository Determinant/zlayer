# ZLayer

**A modern, lightweight EFB. Layer by layer.**

**[Open ZLayer →](https://zlayer.tedyin.com/)** ·
[Features and getting started](https://zlayer.tedyin.com/about/)

ZLayer is a **free, open-source electronic flight bag (EFB) and flight planner**
designed for phones, tablets, and desktops. Explore FAA charts, build routes, read
approach plates, and inspect aviation weather in one workspace. Open it in your
browser or install the progressive web app (PWA), then download supported regions
for offline use. No account or subscription is required. ZLayer will stay free forever.

[![ZLayer with FAA charts, a planned route, terrain contours, and airport information](public/about/workspace.webp)](https://zlayer.tedyin.com/)

*Screenshot of the app; check current chart editions and weather times in ZLayer.*

## What you can do

| Capability | Available today |
| --- | --- |
| FAA charts and navigation | VFR sectional and IFR low/high charts; airport, NAVAID, fix and VFR waypoint search |
| Route planning | Airports, fixes and airways; preferred/TEC routes; published procedure previews; named routes saved locally |
| Aviation weather | METAR/TAF, advisories, AWC/WPC analysis and forecasts, cloud/icing/wind fields, and NOAA radar with recent history |
| Plates and notices | Approach plates, airport diagrams, Chart Supplements, airport/procedure NOTAMs and graphical TFRs |
| Terrain and map tools | Route/viewport terrain, FAA obstructions, glide planning, measurement and optional device GPS |
| Offline regions | Verified downloads for supported U.S. states and territories, with chart editions, progress and storage status |

## Use it on your devices

1. Open **[zlayer.tedyin.com](https://zlayer.tedyin.com/)** in a modern browser with WebGL2.
2. On iPhone or iPad, use Safari → Share → **Add to Home Screen**. On Android,
   use Chrome's install or **Add to Home Screen** option. A desktop browser tab works too.
3. Open **Settings → Offline**, download your regions, and wait for **Saved**.
   On iOS, install first and download inside the installed app. Check your needed
   charts and plates with the network disconnected before relying on offline access.

Routes, settings and downloads stay in each browser or installed app; there is no
account-based cloud sync. Copy/share route text to move a route between devices.
Regional downloads do not include complete satellite basemap coverage, and fresh
weather requires a connection. The FAA feed determines chart/procedure coverage;
this is not a worldwide chart collection.

Targets include modern desktop browsers, Android Chrome and iOS/iPadOS Safari 18+.
Installed-device offline, storage-pressure, GPS and performance qualification remains
ongoing. See [compatibility](docs/verification/graphics-compatibility.md) and
[offline storage](docs/features/offline-storage.md) for requirements and limitations.

ZLayer is a supplemental planning tool, not an official briefing source or certified
EFB. It does not file flight plans or provide fuel/performance calculations or
terrain-clearance assurance. The experimental AHRS toolbox has not been validated
in flight. See the [roadmap](docs/product/roadmap.md) for current capabilities and
planned work, including satellite weather imagery.

## Direction

- Cached charts and routes open immediately; refresh happens in the background.
- FAA features and weather render as MapLibre layers, never one DOM marker per item.
- Airport detail opens the selected procedure or minimums page directly.
- Regional offline downloads are explicit, verified and tied to their FAA edition;
  route-corridor downloads remain planned.
- Every layer shows source, valid time, freshness, and degraded state.

`faa-regs` owns FAA chart, NASR, and d-TPP generation. ZLayer consumes that feed and
adds the interactive map, routing, weather layers, procedure viewer, and PWA storage.

## Start here

- [Documentation index](docs/README.md)
- [Direction and principles](docs/product/direction.md)
- [Current capabilities and roadmap](docs/product/roadmap.md)
- [Architecture](docs/architecture/overview.md)
- [Layer design and source layout](docs/architecture/layer-plugins.md)
- [Local development and verification](docs/development/local-development.md)
- [Offline storage, regional downloads and device checks](docs/features/offline-storage.md)
- [Deployment readiness and hosting contract](docs/development/deployment.md)

## Run locally

Use Node.js 24 or newer and run commands from the repository root.

```bash
npm ci
npm run dev
```

`npm run dev` proxies weather and NOTAM requests to `https://zlayer.tedyin.com`,
sharing its prepared data. See [tools/info-server](tools/info-server/README.md) to
opt into a local backend or deploy the service behind an HTTPS reverse proxy.

Development proxies the dated FAA assets at `charts.tedyin.com` so the browser uses
the same feed shape as production. All published chart coverage is discovered from
the feed manifests; the continuous basemap remains visible outside it.

Run `npm run verify:full` before committing, subject to the server-only scope rule
in [AGENTS.md](AGENTS.md#verification-and-documentation). The
[verification guide](docs/development/local-development.md#verification) lists
browser prerequisites, focused commands and the local and hosted CI matrices.
See the [hosting contract](docs/development/deployment.md) for production requirements.

The app lives in `src/`, the info server in `tools/info-server/`, tests in `test/`, and local proxy rules in
`tools/dev-proxy.ts`. Only `packages/contracts` and `packages/domain` are npm
workspaces. Run all commands from the root; `npm run build` produces static `dist/`.

## Status

Routes, the map camera, open panels and plate reading state survive reloads.
The local Route Stash saves named route snapshots, including feature pins and
approach attachments, for later loading; see [routes](src/layers/routes/README.md).
Settings saves complete state/territory selections: VFR/IFR low/high charts, navigation,
applicable procedure/Chart Supplement books and individual-only plates. Verified
saved editions remain authoritative through feed updates and outages; browsing
dates are independent. Viewed files share the same cache without implying complete
regional coverage.

See the [roadmap](docs/product/roadmap.md) for the full capability list and remaining work.
Installed iOS/Android offline, storage-pressure, GPS and performance checks remain
release gates; desktop browser coverage does not establish those guarantees.

## License

Copyright (C) 2026 ZLayer contributors.

Except where otherwise noted, ZLayer's original source code and accompanying
documentation are licensed under the **GNU Affero General Public License,
version 3 only** (`AGPL-3.0-only`). You may redistribute and modify this software
under those terms; see [LICENSE](LICENSE) for the full license. It is provided
without any warranty, including the implied warranties of merchantability or
fitness for a particular purpose.

Commercial use and forks are welcome. Distributing a covered version requires
providing its corresponding source under the AGPL. If you modify the program and
let users interact with that version remotely over a network, you must prominently
offer those users its corresponding source at no charge. The full license governs
these obligations; contributing changes upstream is welcome but is not required.

Separately licensed material retains its existing terms and notices, including the
[SIL Open Font License for the bundled Noto glyphs](public/fonts/Noto%20Sans%20Bold/LICENSE.md),
and third-party dependencies. Incorporated public-domain material remains public
domain. Aviation data, charts, map tiles and other external content are subject to
their own source terms; see the [source register](docs/data/sources.md).
