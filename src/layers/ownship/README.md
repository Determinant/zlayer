# GPS aircraft layer

[Documentation](../../../docs/README.md) / Plugins / ownship

The map attachment scopes its GPS demand, subscription, pending frame, source
listener and map resources independently. Teardown releases GPS and queued work
even if removal of a map layer or image throws.

Open the left-side **GPS** tab to toggle **GPS aircraft** and allow device location.
The compact core switch matches Terrain and AWC Weather, without a separate On/Off
label, and stays available when GPS is off. GPS starts enabled when
there is no saved preference; an explicit Off choice persists. Enabling the layer
centers the map on the first fresh fix with accuracy of 100 meters or better. In north-up, reloading with GPS already enabled
preserves the saved camera through that first fix. Later north-up updates preserve
panning and zooming; **Center aircraft** returns to the current position.
Enabling GPS while its renderer loads still centers on the first fix. Turning it
off and back on during that load also counts as an explicit enable action.

The orientation button beside the zoom controls switches between **N UP** (north
up, the default) and **TRK UP** (GPS ground track up). The choice persists across
reloads and shares the existing GPS watch. Selecting track-up centers the aircraft
and rotates the map to its GPS ground track. Each fresh, accurate fix updates the
center without changing zoom, including the first fix after restoring track-up.
If GPS is off, stale, unavailable, or inaccurate (worse than 100 meters), automatic
movement stops and the camera holds its current center and bearing. Pending GPS
centering and any active GPS follow animation are cancelled; following resumes on
a usable fix. A fresh, accurate position without a ground track still centers the
aircraft while holding the bearing. Missing track shows **Waiting for GPS track**.
North-up works without GPS and does not continuously follow position.

Track-up rotation applies a circular low-pass filter to the combined GPS/sensor
bearing, with a two-second time constant followed by a 3° angular deadband.
This map-only filter damps brief heading changes, including AHRS motion, before
they rotate the whole map; it does not change HSI response. It uses elapsed sample
time rather than a fixed per-callback gain and takes the short path across north.
The GPS reference correction separately uses a three-second time constant with
sensor assistance. Without it, corrections use 1.5 seconds for small errors and
0.75 seconds for errors above 10°; the final map filter still applies to both.
Small GPS fluctuations do not rotate the map, even during position following.
Sustained turns still follow, with some display lag. First acquisition and recovery
seed the bearing directly; north-up remains exactly north. Raw GPS measurements
remain available to status, integrations and recordings. Aircraft/vector display
motion is filtered separately as described below.

Ownship optionally discovers AHRS's leased heading capability. With reported GPS
speed at least 10 m/s (about 20 kt), accuracy within 50 m, and usable motion, AHRS
can carry rotation between fixes without instrument calibration. It shares the
existing AHRS sensor/filter session; it does not create a second IMU pipeline.
GPS ground track remains the long-term reference: a fixed heading/track offset
(such as crosswind or device mounting) is not applied to the map. Delayed GPS
corrections use up to three seconds of acquisition-time heading history. Sensor
assistance cannot push the bearing farther beyond 15° from the latest track and
stops propagating after
three seconds without GPS. A GPS correction already outside that band continues
settling smoothly; a stationary sensor cannot snap it to the limit. Gaps, sensor-frame changes and implausible heading
steps discard relative-motion continuity. These are display limits, not measured
navigation-integrity bounds.

Heading assistance is acquired only for usable track-up demand and released in
north-up, on GPS loss/poor quality, or camera teardown. AHRS removal, unavailable
hardware, denied sensor permission or a failed optional acquisition leave damped
GPS following available. Revoked provider callbacks cannot revive assistance.
Browsers may require a tap to permit motion: switch to north-up and back to
track-up with a usable fix to retry. Restoring track-up cannot bypass that browser
requirement. Keep the device secured; moving it independently of the aircraft
also moves its sensed heading. See [AHRS heading demand](../ahrs/README.md#automatic-heading-demand).

GPS following waits for a pan, zoom, or route-fit animation to finish. A manual
pan or **Fit route** keeps its center until the next usable GPS fix; a fix received
during the movement is applied after it ends. **Fit route**
calculates its center and zoom at the selected orientation, including the held
bearing while waiting for track, and respects the recommendation panel's padding.
Manual rotation returns to the selected orientation when the gesture ends if that
orientation is available.

The blue aircraft stays at the exact current GPS position and points along a
smoothed GPS ground track in degrees true, including when the map is rotated. A solid blue track
vector starts there and shows the next minute's trend at current groundspeed:
straight in steady flight and curved with the recent ground-track turn rate.
There is no separate future-position marker. Like the
[G1000 track vector](https://static.garmin.com/pumac/190-00647-03_A.pdf),
the displayed arc stops at 90° of turn if reached before one minute. It does not
follow the planned route. The status shows true track, knots, and reported
horizontal accuracy in meters. A shaded circle displays that accuracy on the map.

Turn rate is estimated from up to six seconds of continuous GPS tracks, with at
least three seconds of samples. Tracks unwrap across north. Curvature confidence
fades in continuously from 0.3 to 1°/s, with both halves of the window supporting
the same turn. Full confidence requires at least 1.5° of travel in each half and
fitted travel exceeding three times the RMS residual noise by 1.5°. The weakest
of these three factors controls curvature. This replaces a hard straight/curved
cutoff that amplified tiny noise near its threshold.

Aircraft direction and the vector's initial tangent share a circular two-second
low-pass filter; curvature has the same elapsed-time damping. Neither filter
modifies the shared fix, its timestamp, reported track/speed or the vector's exact
position anchor. Filtering runs only on new fixes, without timers or extra sensor
demand. It suppresses small or reversing GPS errors at the cost of a few seconds
of turn-onset and level-out lag, and attenuates uncertain shallow turns. These are
display heuristics, not a confidence or integrity estimate; correlated GPS drift
can still resemble a real turn.
Motion history, continuity checks and filter gains use core's normalized monotonic
acquisition `time` in seconds. The original epoch `timestamp` remains provenance;
accepted timestamp rounding cannot change these elapsed-time calculations.
Sampling and continuity boundaries tolerate one nanosecond of floating-point
roundoff so exact intervals retain their samples and full turn baseline; fixes
and filter gains remain unrounded.
Gaps longer than 2.5 seconds, missing motion,
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
jumps. The accepted position remains available as a dot with unknown velocity;
it cannot generate an unbounded projection. Movement below 1 m/s,
unknown track, or accuracy worse than 100 meters uses a position dot. Missing
speed suppresses the projection. A fix that has not updated for 10 seconds becomes
a gray last-position dot with **GPS fix stale**; the projection is removed.
The service restarts a silent watch to request a fresh uncached position, since
browser watches need not send periodic updates while stationary. Core also imposes
a 15-second acquisition deadline on each new watch, including replacements, when
the browser supplies neither fixes nor errors. Acquisition failures retry after
five seconds, retaining a clearly stale last position where available. Permission denial stops retries until the user retries
or returns to the app. Reacquisition preserves panning in north-up and resumes
centering in track-up; replacing the map centers the new map on its first fresh
fix unless it restores a saved north-up camera.

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

The GPS switch expresses Ownship demand, not successful acquisition. **Retry GPS**
explicitly restarts the shared watch even while AHRS holds its lease. Clock changes
and sleep recovery belong to core; consumers receive the same normalized fixes and
clear their motion history across interruptions.

AHRS can calibrate and show live IMU attitude even if this source has never supplied
a fix. No fix or a fix below the aiding speed puts a red cross over the moving AI;
usable GPS clears it only while tilt uncertainty is acceptable. High uncertainty
also keeps the cross without hiding live attitude. The HSI remains visible and
its card follows live IMU yaw beneath **No GPS**, labeled **REL** when a geographic
heading is unavailable. This does not supply missing route guidance, map position
or GPS instrument readings; see the
[AHRS display policy](../ahrs/README.md#calibration-and-validity).

`createOwnshipPlugin(gps)` and `createOwnshipLayer(gps)` receive the workspace's
shared GPS service explicitly. Ownship owns its map demand, centering requests and track
trend in `layer.ts`; `position.ts` calculates turns and projections, `geometry.ts`
builds map features, `map.ts` owns MapLibre resources, and `controls.tsx` owns
controls and status. Core's `gps/service.ts` owns the browser watch, leases,
freshness, retries and background suspension; `gps/position.ts` validates and
normalizes fixes, including marked velocity estimates. The workspace registers
Ownship in the `ownship` rendering slot above route and navigation labels.
The workspace's `map/gps-camera.ts` is the sole owner of GPS camera movement,
including initial and explicit centering, track-up following, accuracy gating,
gesture deferral and cancellation. `map/navigation-control.ts` owns the orientation
button. Initial/explicit centering raises zoom to at least 9; ordinary following
preserves zoom. All GPS animations stop when their fix becomes unusable, without
cancelling user camera movements. Deferred fixes are discarded on loss of validity.
The map renderer remains lazy loaded. Heading updates reach the camera directly;
they do not publish Ownship geometry or React status snapshots.

### Rendering and battery work

Disabled Ownship releases both its GPS lease and subscription, clears its local
motion history, and stays idle even when another consumer uses GPS. Enabling joins
the latest shared fix immediately. Remounting the renderer restores its source
without replaying initial centering on the same map; replacing the map starts a
new centering policy. Restored cameras and explicit enable actions during lazy
loading keep their existing precedence.

Freshness and visual identity are separate. Timestamp, altitude and velocity
provenance updates remain available to consumers without rebuilding unchanged map
geometry. The renderer uploads only changes to position, accuracy, live/stale
appearance or track/vector geometry. Multiple live callbacks before a frame build
only the latest geometry once. Disabling or losing validity cancels pending live
work and removes live geometry immediately; unmount cancels the pending frame.
A source error invalidates visual reuse so the next fresh fix can retry even
without movement. There is no recurring animation-frame loop or idle rendering timer.

Camera following retains only the latest pending fix during a movement and skips
bearing changes within the angular deadband and center shifts smaller than half a
CSS pixel. When ground track or speed of at least 1 m/s is unavailable, a shift
must also exceed twice the current accuracy radius (at least 5 m) from the camera
center. This avoids chasing parked drift at high zoom while accumulated movement
still recenters. Confirmed motion keeps precise following. The aircraft feature
retains the exact measured position; explicit centering bypasses both thresholds.
Orientation labels change only when their displayed
state changes; the status panel also selects its displayed text and controls so
unchanged fixes do not rerender React. Automatic track-follow camera saves are
coalesced on a fixed two-second deadline; manual camera changes and explicit
centering save immediately, and hiding/teardown samples and flushes the live camera. See [camera persistence](../../../docs/architecture/workspace-persistence.md).

Unit regressions count geometry uploads, queued frames, camera commands and
persistence writes, and cover synchronous teardown/re-enable. Browser regressions
exercise the real renderer and initial-centering cancellation. These bounded-work
checks do not measure battery life; installed-device energy and frame-time profiling
remain necessary before claiming a measured battery improvement.
The [Glide planner](../glide/README.md#work-and-recovery) separately filters small
position drift and retains nearby ranges during calculation. Automatic GPS camera
following does not cancel its terrain worker on each fix.
Motion regressions also cover shallow turns with noise near the former cutoff,
display-direction jitter across north at 1/5/10 Hz, sustained turns and level-out,
raw-fix preservation and high-zoom stationary drift.

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

## Passive position observation

The typed `OwnshipApi.position` store exposes the existing enabled state and GPS
snapshot through the scoped plugin bridge. Consumers share the map's GPS lifecycle
and do not acquire a second watch. [Glide](../glide/README.md) uses fresh, accurate
positions first acquired on screen for its teal planning ring; completed ranges
remain cached while panning away from that same position. It takes MSL altitude from its
planning slider, not the browser's raw altitude. Removing Ownship revokes the
store connection and clears dependent rings.
