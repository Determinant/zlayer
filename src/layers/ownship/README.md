# GPS aircraft layer

[Documentation](../../../docs/README.md) / Plugins / ownship

Open the left-side **GPS** tab to toggle **GPS aircraft** and allow device location.
The compact On/Off switch stays available when GPS is off. GPS starts enabled when
there is no saved preference; an explicit Off choice persists. Enabling the layer
centers the map on the first fix. Reloading with GPS already enabled preserves the
saved camera through that first fix. Later updates preserve panning and zooming;
**Center aircraft** returns to the current position.
Enabling GPS while its renderer loads still centers on the first fix. Turning it
off and back on during that load also counts as an explicit enable action.

The orientation button beside the zoom controls switches between **N UP** (north
up, the default) and **TRK UP** (GPS ground track up). The choice persists across
reloads and shares the existing GPS watch. Track-up rotates the map without
recentering or changing zoom. If GPS is off, stale, inaccurate, or has no usable
track, it holds the current bearing and shows **Waiting for GPS track**; following
resumes when a usable track returns. North-up works without GPS.

GPS rotation waits for a pan, zoom, or route-fit animation to finish. **Fit route**
calculates its center and zoom at the selected orientation, including the held
bearing while waiting for track, and respects the recommendation panel's padding.
Manual rotation returns to the selected orientation when the gesture ends if that
orientation is available.

The blue aircraft stays at the current GPS position and points along GPS ground
track in degrees true, including when the map is rotated. A solid blue track
vector starts there and shows the next minute's trend at current groundspeed:
straight in steady flight and curved with the recent ground-track turn rate.
There is no separate future-position marker. Like the
[G1000 track vector](https://static.garmin.com/pumac/190-00647-03_A.pdf),
the displayed arc stops at 90° of turn if reached before one minute. It does not
follow the planned route. The status shows true track, knots, and reported
horizontal accuracy in meters. A shaded circle displays that accuracy on the map.

Turn rate is estimated from up to three seconds of continuous GPS tracks, with at
least one second of samples. Tracks unwrap across north; small changes below
0.1°/s are treated as straight flight. Gaps longer than 2.5 seconds, missing motion,
changes between reported and estimated velocity, or track jumps above 12°/s
restart the continuous sampling window. The rate calculation uses samples at
least 100 ms apart so rounded headings in rapid callbacks do not imply extreme
turns; missing motion and source changes still reset continuity between samples.
Without a usable estimate the vector stays straight.
Stopping, poor accuracy, stale fixes, acquisition errors and suspension clear the
turn history. This is a GPS tendency display, not an IMU-driven flight-path forecast.

The device's Geolocation API supplies position and, when available, track and
speed through [core's shared GPS service](../../../docs/architecture/layer-plugins.md#shared-gps-service).
When velocity is missing, that service estimates it from a short sampling
window, normally about two seconds (at least one second during startup). This
also works when updates arrive several times per second. The displacement must
exceed the fixes' combined accuracy and 5 meters. Estimated values are labeled
**Est.** The baseline expires when stationary and resets after a reported stop,
poor accuracy, an acquisition error, or suspension. Motion exceeding 1,500 m/s
is rejected as implausible for this aviation display, including provider position
jumps; it cannot generate an unbounded projection. Movement below 1 m/s,
unknown track, or accuracy worse than 100 meters uses a position dot. Missing
speed suppresses the projection. A fix that has not updated for 10 seconds becomes
a gray last-position dot with **GPS fix stale**; the projection is removed.
The service restarts a silent watch to request a fresh uncached position, since
browser watches need not send periodic updates while stationary. Transient
acquisition failures retry after five seconds, retaining a clearly stale last
position where available. Permission denial stops retries until the user retries
or returns to the app. Reacquisition preserves panning; replacing the map centers
the new map on its first fresh fix unless it restores a saved camera.

GPS requires HTTPS (localhost also works), location permission, and a device
location provider. High accuracy is requested; the browser chooses the provider.
The layer has no network dependency for location updates, but offline fixes still
depend on the device's location provider. Map coverage depends on saved data.
Hidden/background apps pause the watch and reacquire a fresh fix on return. The map
and AHRS independently lease the same core service, sharing one watch. Turning the
map layer off or detaching it releases Ownship's lease. The service clears its watch,
timers and velocity sampling history when the last consumer releases its lease.
Disabling Ownship does not disable AHRS or interrupt its GPS; disabling AHRS does
not interrupt Ownship. Stop all consumers to stop location use. Neither the service
nor Ownship saves position history; optional [AHRS recordings](../ahrs/recording.md)
do include GPS fixes.

AHRS can calibrate and show live IMU attitude even if this source has never supplied
a fix. No fix or a fix below the aiding speed puts a red cross over the moving AI;
usable GPS clears it only while tilt uncertainty is acceptable. High uncertainty
also keeps the cross without hiding live attitude. The HSI remains visible and
its card follows live IMU yaw beneath **No GPS**, labeled **REL** when a geographic
heading is unavailable. This does not supply missing route guidance, map position
or GPS instrument readings; see the
[AHRS display policy](../ahrs/README.md#calibration-and-validity).

`createOwnshipPlugin(gps)` and `createOwnshipLayer(gps)` receive the workspace's
shared GPS service explicitly. Ownship owns its map demand, centering and track
trend in `layer.ts`; `position.ts` calculates turns and projections, `geometry.ts`
builds map features, `map.ts` owns MapLibre resources, and `controls.tsx` owns
controls and status. Core's `gps/service.ts` owns the browser watch, leases,
freshness, retries and background suspension; `gps/position.ts` validates and
normalizes fixes, including marked velocity estimates. The workspace registers
Ownship in the `ownship` rendering slot above route and navigation labels.
The map renderer remains lazy loaded.

## Release verification

Browser regressions cover map rotation, the one-minute projection, missing velocity,
poor accuracy, stale fixes, denial/recovery, watch cleanup, map replacement, dateline
crossings, phone-size controls and cold offline launch. Native browser API tests
use emulated coordinates; visibility tests simulate suspension. Check the native
permission prompt in a fresh headed session without pregranting permission, and
verify the app version served by the intended HTTPS deployment. Follow the
[hosting and release checks](../../../docs/development/deployment.md) for that verification.

Run `npm run test:browser -- test/e2e/ownship.spec.ts test/e2e/ownship-review.spec.ts`
for rendering and native Geolocation API checks. The targeted
[graphics matrix](../../../docs/verification/graphics-compatibility.md#run-the-checks) uses deterministic fixes
across Chromium, Firefox and WebKit; native API coverage remains in the full suite.

Before approving the mobile release, record these checks on installed iOS and
Android PWAs using the intended HTTPS deployment:

- First-use permission with GPS enabled by default; denial and recovery after
  changing site/device location settings. Reset only location permission when
  testing the prompt so saved offline data remains available.
- Actual movement with the device provider: position, true ground track, speed
  and projection, including stopping and reduced accuracy.
- Loss of fresh fixes removes the projection and marks the last position stale;
  recovery restores tracking.
- Screen lock, app switching and return reacquire a fresh fix without duplicate
  watches or stale motion. Turning the layer off with AHRS stopped ends location use;
  an active AHRS session keeps the shared watch until it too stops.
- Airplane-mode cold launch restores the enabled layer and can acquire location
  when supported by the device; saved map coverage remains usable.

These physical-device checks remain outstanding. Desktop automation supports a
beta release assessment but does not establish mobile GPS behavior.

References: [W3C Geolocation](https://www.w3.org/TR/geolocation/),
[MapLibre symbol rotation](https://maplibre.org/maplibre-style-spec/layers/#icon-rotation-alignment).
