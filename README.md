# ZLayer

**A modern, lightweight EFB. Layer by layer.**

ZLayer is an offline-capable aviation PWA designed for phones, tablets, and desktops.
It combines FAA charts, navigation and procedures with METAR/TAF weather, route
planning, terrain and optional device GPS in one MapLibre/WebGL workspace. An
experimental AHRS toolbox adds attitude, GPS instruments, an HSI and local recordings;
it has not been validated in flight. Each product owns its data, behavior and
interface. WPC analysis and NOAA radar/satellite imagery remain planned.

## Direction

- Cached charts and routes open immediately; refresh happens in the background.
- FAA features and weather render as MapLibre layers, never one DOM marker per item.
- Airport detail opens the selected procedure or minimums page directly.
- Regional offline downloads are explicit, verified and tied to their FAA edition;
  route-corridor downloads remain planned.
- Every layer shows source, valid time, freshness, and degraded state.

`faa-regs` owns FAA chart, NASR, and d-TPP generation. ZLayer consumes that feed and
adds the interactive map, routing, weather layers, procedure viewer, and PWA storage.

ZLayer begins as a supplemental planning tool, not an official briefing source or
certified EFB.

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

`npm run dev` proxies weather to `https://zlayer.tedyin.com`, sharing GCP's prepared
forecasts. See [tools/weather-server](tools/weather-server/README.md) to opt into
a local backend or deploy the service behind DigitalOcean's HTTPS proxy.

Development proxies the dated FAA assets at `charts.tedyin.com` so the browser uses
the same feed shape as production. All published chart coverage is discovered from
the feed manifests; the continuous basemap remains visible outside it.

Run `npm run verify:full` for full local CI before committing: import boundaries,
strict TypeScript, unit tests, the production build, all Chromium browser tests,
and the complete Chromium/Firefox/WebKit/2× WebKit graphics matrix.
Install browsers with `npx playwright install --with-deps chromium firefox webkit`;
see [graphics compatibility](docs/verification/graphics-compatibility.md) for the Linux Firefox
display requirement. The individual `verify`, `test:browser` and `test:graphics`
commands remain available.
GitHub pushes and pull requests run `verify` and the smaller `test:smoke` suite.
Full local CI retains all tests. **Actions → Verify → Run workflow** with **full**
enabled also runs the complete hosted matrix, including macOS WebKit;
see [verification](docs/development/local-development.md#verification).
See the [hosting contract](docs/development/deployment.md) for production requirements.

The app lives in `src/`, the weather gateway in `tools/weather-server/`, tests in `test/`, and local proxy rules in
`tools/dev-proxy.ts`. Only `packages/contracts` and `packages/domain` are npm
workspaces. Run all commands from the root; `npm run build` produces static `dist/`.

## Status

Routes, the map camera, open panels and plate reading state survive reloads.
The local Route Stash saves named route snapshots, including feature pins and
approach attachments, for later loading; see [routes](src/layers/routes/README.md).
Settings saves complete state/territory selections: VFR/IFR low charts, navigation,
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
