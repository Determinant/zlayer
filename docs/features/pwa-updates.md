# App updates

[Documentation](../README.md) / Features

ZLayer downloads and installs a new application shell in the background. It offers
**Update available** with the version once the new service worker has activated
and controls the page. **Update now** reloads that window into the prepared shell;
**Later** dismisses the banner for that release in the current page. It does not
pin the app to that release. Settings → **App updates** always shows the running
version, offers **Check for updates**, and
keeps **Update now** available after dismissal.

Versions use `v0.1.0+g1234567.b89abcdef`: the version from `package.json`
(currently `0.1.0`), the first seven characters of the Git commit, and the first
eight characters of the build hash. Bump `package.json` and its lockfile for a
new semantic version. Builds read the full commit from `git rev-parse HEAD`;
when building a source archive without Git metadata, supply the full commit in
`ZLAYER_GIT_COMMIT`.

Update comparisons and cache keys retain a longer, 16-character internal ID.
Its SHA-256 input covers the package version, full Git commit, built asset names
(which contain content hashes), worker code, HTML and public shell files, so
changes to built app content get a different ID even before they are committed.
The build inserts the same ID and display version into `index.html` and `sw.js`.
Reading the document's ID separately from the worker's ID distinguishes the
running page from the newly installed shell. The worker's `app-release` reply
keeps the original `release` field and adds `displayVersion`, allowing older
installed pages to continue detecting updates. New pages also accept replies
from older workers that report only the ID.

Update checks run at startup, when the app becomes visible or focused, when
connectivity returns, and every five minutes while visible and online. Foreground
events are throttled to one check per 30 seconds; manual checks bypass that
throttle; clock rollback also permits a new check. Mobile operating systems can
suspend background apps, so a release is not guaranteed to download while the app is closed. Reopening an installed PWA
can resume its existing document rather than load it again.

The worker continues using `skipWaiting()` and `clients.claim()` after its complete
shell download. This preserves automatic updates for older clients that do not
yet contain the prompt. Activation alone does not replace the JavaScript already
running in a window. Each open window gets its own prompt. The update monitor
reloads a window only when its update button is clicked, but the browser or OS can
also restart it. Reopening or reloading after an update has installed can load the
latest shell automatically, without ever showing the prompt. This is a reload
control, not an approval requirement for every app update.

An installed worker can remain waiting when activation is delayed or its original
request is lost. The monitor observes waiting workers on startup and asks them to
activate again on installation and manual checks. Installation ends the download
state, so **Check for updates** remains usable. The worker accepts activation only
with a validated complete shell; **Update now** still requires an activated worker
controlling the page. Fetch response/cache work is explicitly included in the
fetch event lifetime, allowing the outgoing worker to finish before handover.
No recovery path reloads the page without a user action.

Old shell caches remain available for older windows' lazy assets. Cache cleanup
pauses during installation and stops if activation changes while it is running.
Routes, preferences, saved regions and chart/PDF caches are not erased by an app
update. In-progress activity is interrupted by the requested reload.

A failed download keeps the current shell working and does not offer the failed
release. Installation and shell recovery validate the page's release ID before
caching it, download the assets atomically, and save the validated page last as
the completion marker. A deployment change that produces a mismatched page
cannot leave rejected HTML in the cache. Recovery revalidates an existing cached
page and removes a mismatched one before retrying the download. Navigation also
validates cached pages; its network fallback does not cache HTML or establish
offline readiness without the assets. These checks also apply when an existing
worker rebuilds its shell after a local reset.

Once a release is ready, its update button also works offline. An app
launched offline still observes its existing registration and checks on reconnect.
Keep `/sw.js` served with `Cache-Control: no-store`, as in the
[Caddy hosting configuration](../../tools/hosting/Caddyfile); apply the same
policy with other web servers.
Ordinary releases need no reinstall or site-data reset. Selected data-format
changes can offer the optional reset advisory below.

## Reset advisory

Releases can carry a stable `resetAdvisory` ID. **Update now**, whether opened
from the map bubble, General or Notifications, reads that ID from the activated
worker and offers **Reset app data?** once for that data-format change. Background
checks do not show this dialog. **Reset now** immediately starts the existing
[coordinated full reset](offline-storage.md#full-local-reset); this explicit choice
replaces the manual Settings `DELETE` step for the advisory only. The dialog names
the local data being deleted and the need to reconnect and download regions again.
**Keep data and update** reloads into the prepared shell without deleting anything.
Escape closes the dialog without reloading or resetting.

Already installed pages cannot acquire new UI until they reload. On the first
launch of an advisory-enabled shell, older data caches or saved region records
therefore trigger the same dialog before mounting the workspace. This also covers
automatic upgrades and users who skip releases. The secondary action then reads
**Keep my data**. Fresh installations silently mark the current ID handled and
never see its advisory, even after subsequently downloading regions.

Each ID is claimed once per browser origin, across windows and reloads, regardless
of the user's choice. The claim uses a Web Lock when available and a small local
receipt; denied storage retains suppression only for that page session. Full reset
removes those receipts along with all other app data; the next clean launch again
silently handles the current ID. Compatible follow-up releases keep the same ID.

The build defaults to off. Set `ZLAYER_RESET_ADVISORY=artcc-2026-10` for the upgrade
covering older offline navigation data that lacks ARTCC associations used by
regional FIR/NOTAM display. Operators can unset it or set `off` to disable the
advisory, or supply a new stable ID for a future format change. Keep an ID enabled
while users may skip directly across the affected releases; do not generate one
per deployment. The ID is embedded in both
HTML and the worker and participates in the release hash. Older worker replies
without this field still work. See the [deployment options](../development/deployment.md#reset-advisory-option).

## Verification

`test/offline-shell.test.ts` verifies matching page/worker versions, reproducible
builds, and distinct IDs for source or commit changes. `test/pwa-updates.test.ts`
covers lifecycle events, foreground checks, failures, legacy replies, truncated
hash collisions and single-reload behavior. The “up to date” status requires a successful server check;
reading the cached worker's release alone is insufficient.
`test/e2e/pwa-updates.spec.ts` changes the served release on the actual test origin.
It exercises two windows, a failed download, a mobile viewport, offline updates
with saved data, automatic updates after reopening, installation during cache
cleanup, mismatched page/worker releases, and repeated shell recovery failures
followed by a successful offline launch. Device-level Android and iOS testing
remains part of release verification.
The same suite covers all three advisory entry points, offline continuation with
data intact, the legacy-data fallback, cross-window suppression and immediate reset.
`test/reset-advisory.test.ts` checks fresh installs, durable receipts and denied storage.

The October 1, 2026 recovery regression followed a rejected mismatched deployment:
a repaired worker could remain waiting after reload while the monitor kept
**Check for updates** disabled. Waiting-worker observation, activation retries
and explicit fetch event lifetimes address this path. The mismatch browser test
keeps this recovery sequence; the additional lost-activation test requires a
complete release to recover and reload offline. Run focused recovery checks with
`ZLAYER_TEST_SKIP_WEATHER=1 npm run test:browser:session --
test/e2e/pwa-updates.spec.ts --grep "mismatched page" --repeat-each=8`.

The update bubble also dismisses when its body is tapped or clicked. Its update
action remains available in **Settings → Notifications**, alongside other
[active workspace notices](shared-ui.md#notifications), and in General → App updates.
