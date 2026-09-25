# AHRS tool

[Documentation](../../../docs/README.md) / Plugins / ahrs

The optional Routes public API supplies the committed route for the HSI through the
[core plugin bridge](../../../docs/architecture/layer-plugins.md#inter-plugin-communication).
Disabling Routes removes route guidance while AHRS and its independent GPS lease remain active.

This folder owns the estimator, browser motion adapter, calibration, attitude and
GPS instruments, HSI, controls and local recordings. It has no runtime or build
dependency on the standalone `zlayer-ahrs` repository. The entire tool, including
`estimator/`, uses the project's [AGPL-3.0-only license](../../../LICENSE).
Estimator copyright (c) 2026 zlayer-ahrs contributors.
The tool is experimental and has not been validated in flight.

## Contents

- [Display principles](#display-principles)
- [Integration and sensor lifecycle](#integration)
- [GPS instruments](#ground-speed-altitude-and-vertical-speed)
- [Compact HSI](#compact-hsi)
- [Calibration and validity](#calibration-and-validity)
- [Tilt aiding and heading acquisition](#tilt-aiding-and-heading-acquisition)
- [Relative magnetic fusion](#relative-magnetic-fusion)
- [Verification](#verification)

Detailed equations live in [gravity/acceleration fusion](estimator/gravity-aiding.md),
[heading acquisition](estimator/heading-alignment.md),
[GPS aiding before north alignment](estimator/velocity-change.md),
[magnetic fusion and calibration](estimator/magnetic-fusion.md) and
[uncertainty](estimator/uncertainty.md). See [validation](validation.md) for numerical
evidence and remaining checks, and [recordings](recording.md) for capture/replay.
Historical pointers for the [superseded steady-window tilt method](estimator/steady-tilt.md)
and [superseded magnetic drift aid](estimator/magnetic-drift.md) identify their replacements.

## Display principles

**Show what is available and flag its limitations.** Availability and confidence
are separate decisions for each reading. A red cross communicates uncertainty or
a missing input; it must not blank other information that the instruments can
still provide. Keep available attitude, heading and route information visible
beneath the warning. Leave a value unavailable only when its own required inputs
or usable retained reference are missing.

**The HSI should have a smooth geographic heading whenever one can be established.**
Usable GPS track can initialize an estimated heading; calibrated gyros carry it
between fixes, and subsequent corrections settle gradually. The AHRS session owns
that reference. The compass must not jump directly between raw GPS track readings.
Ground track remains a separate indication, and estimated heading remains labeled.

**REL is the last fallback.** Use relative yaw only until the session has a
geographic reference. GPS loss, low speed or growing uncertainty must not erase
an established reference. Continue with the information still available and its
warning; do not invent motion during missing samples. These requirements apply
equally in the toolbox, full screen and after returning from the background.
The [HSI behavior](#heading-and-guidance-behavior) and
[calibration rules](#calibration-and-validity) specify the individual cases.

## Integration

### Sensors and display lifecycle

`createAhrsLayer(gps)` accepts a source-neutral GPS port (`AhrsGpsSource`).
The workspace supplies [core's shared GPS service](../../../docs/architecture/layer-plugins.md#shared-gps-service)
directly. AHRS has no Ownship plugin dependency: you can enable it, calibrate and
receive GPS with Ownship disabled. `acquire()` holds a shared location lease; it neither
enables the map aircraft nor moves the camera. Stopping or disabling AHRS releases
only its own lease. Ownship can continue using the same browser watch, and disabling
Ownship cannot stop an active AHRS session's GPS.
Sensors start from the confirmation button and stop on **Stop**, cancellation,
unrecoverable failure, or unmount. Stowing AHRS through its tab, Escape, or another
toolbox offers **Stop**, **Background**, and **Cancel**. **Stop** is the prominent,
initially focused default: it ends motion sensing and recording, releases the AHRS
GPS lease, and clears calibration before stowing. Reopening requires calibration.
**Background** stows while preserving the running calibration/attitude;
**Cancel** (including Escape) leaves the toolbox and session open. Sensor processing
continues until the user chooses. The Stop button spans the first row; Background
and Cancel share the second row, with at least 44-pixel touch targets.
`setVisible(false)` stops display publication while keeping the shared GPS lease
and existing GPS fusion. Calibration and estimation receive every delivered IMU
sample, whether open or stowed. Dropping selected samples can turn vibration into
false rotation; visibility therefore only reduces display work. The browser
controls the available sensor rate.
Display subscriptions and animation frames stop while the toolbox or page is
hidden. Reopening reads the current attitude and resets display-only tape/drum
smoothing. The horizon, HSI, tapes and drums share one animation clock capped at
60 FPS, including on higher-refresh screens; idle/stopped instruments schedule
no animation frames. The HSI reads the same current estimator snapshot as the horizon;
it does not wait for the 20 Hz status-control publication timer. Display frames,
status snapshots and route calculations pause while hidden. Reopening
immediately publishes a fresh snapshot and preserves the selected HSI leg.
There is no entry in the right-hand layer menu.

While calibration, live attitude or the Test demo is visible, AHRS requests a
screen wake lock to prevent idle screen sleep. Stowing the toolbox (including
**Background**), hiding the page, stopping or unmounting releases it; returning to
an active display requests it again. Full-screen changes retain the same lock.
This requires browser support and HTTPS. The OS can decline or release the lock
for power-saving reasons; manual screen locking still works. Safari Home Screen
web apps support it from iOS/iPadOS 18.4 ([WebKit release notes](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)).
Actual device auto-lock behavior still requires phone/tablet verification.

Stopping, canceling calibration, or an unrecoverable fault clears the GPS instruments,
HSI guidance and GPS-live badge along with the AHRS location lease. A separate
map GPS consumer can continue tracking, but cannot leave old GPS values displayed
as live in AHRS. A fault retains the last available HSI heading under its warning;
stopping or starting a new calibration clears that reference and releases the old
estimator replay history. Once calibration is applied, its raw IMU/GPS window is discarded; the
estimator retains the resulting trim and bias. Stowing with **Background** and
temporary sensor pauses preserve the running estimator.
Temporary motion pauses keep the session, including when returning from a hidden
page. Fresh readings resume calibration or attitude automatically. The shared GPS
provider may suspend its hardware watch while hidden and restart it on return.
GPS acquisition times are normalized to the motion clock by core when received.
AHRS consumes that time directly, preserving delivery delay and its stricter
three-second freshness/quality gates. It does not derive GPS time from a fixed
epoch offset or own a separate watch/retry loop. This permits fresh GPS to recover
after device sleep or wall-clock corrections without reloading or recalibrating.

### Toolbox and full screen

The recorder and **Enter full screen** buttons form a centered pair in the top
bezel, sharing 40-pixel widths and growing to 44-pixel squares in full screen.
The full-screen control and viewport-filling surface use core's `FullScreenButton`
and `PanelSurface`, also used by Plates. The expand/contract icon grows to 20 pixels.
The same native dialog and instrument tree remain mounted in both modes; core owns
modality, viewport framing and focus, while AHRS owns its fullscreen preference,
instrument layout and sensor/recording lifecycle. Its top-layer dialog excludes background focus;
**Exit full screen** or the first Escape returns to the toolbox and restores
focus to the button. A subsequent Escape uses the existing stow confirmation.
The header remains reachable while ancillary controls scroll; safe-area insets
and the shared visual viewport keep it usable with rotation and mobile keyboards.
Instruments sit side by side in landscape and stack in portrait. Tablet portrait
places the HSI readings and route selector beside the compass, below the attitude
display. Tablet text sizes and landscape compass sizing keep navigation details
visible alongside the instruments, including on the mini and 4:3 displays.
Narrower tablet windows use the compact layout. The preference persists, and
toggling preserves the same instrument nodes, live calibration,
GPS lease, display damping, selected HSI leg and running Test demo.

### Recording

The recorder icon beside full screen opens **Start recording**, **Stop recording**,
and saved recordings with **Download** and **Delete** actions. Deletion asks for
confirmation and removes one session's local metadata and samples. Stop the
current recording before deleting it. Start before calibration to capture the complete session.
Starting recording ends the Test display; simulated readings never enter a log.
Recording continues when the toolbox is stowed and ends when AHRS is stopped.
Keep the app in the foreground: the browser can suspend motion and JavaScript
when the page is hidden or the device locks. Downloads work offline in the saved
PWA, including after a reload. Interrupted sessions are labeled **Partial**.
See [recording.md](recording.md) for the JSON Lines format and persistence limits.

### Display demo

**Test**, below the calibration/session controls, remains available before, during
and after calibration, in the toolbox and full screen. It runs a labeled display
demo without requesting motion or location permissions. An existing sensor session
and any calibration in progress continue while the demo is shown.
One-second simulated fixes drive the production GS/ALT animation through
rising/falling digit boundaries, negative altitude and zero;
the GPS VSI follows the climb/descent, and the horizon and HSI heading, track, CDI
and distance move along a private test route. The demo does not change the workspace
route or existing calibration.
**Stop test**, starting/canceling calibration, stopping AHRS, canceling setup, or
hiding the toolbox/page ends it and releases its display timers. The live HSI keeps
its selected leg.

### Attitude symbols

The bank indicator follows `loupe-flightdeck`: the gold triangle stays fixed
with the aircraft reference bar, while the white bank scale and its zero index
rotate with the horizon. Its uniform scale preserves angles and keeps the marks
clear of the GS/ALT tapes, including at steep and inverted attitudes.
The fixed aircraft symbol uses dark-filled, gold-outlined split wings and a
small center square. The wings' upper edges remain the zero-pitch reference,
leaving the center of the pitch ladder open.

### Uncertainty diagnostics

AHRS uncertainty covers **roll, pitch, and yaw**, combining usable sensor evidence,
bias uncertainty, reference alignment, and model ambiguity. GPS availability,
ground speed, or a mode label alone does not determine confidence. See
[AHRS uncertainty](estimator/uncertainty.md) for the definition, expected steady
behavior, and the distinction between relative yaw and absolute heading.

The **Tilt uncertainty** summary below the live attitude indicator shows the filter's
largest tilt standard deviation in degrees; it is only part of overall attitude
uncertainty. Expand it for a two-minute trend,
roll/pitch/local-yaw/heading standard deviations, separate sensor aiding and heading
alignment status, correction ages, and used/rejected GPS update counts. Green trend
segments mark recent gravity, raw magnetic vector, or GPS aiding; amber segments
mark propagation without those tilt-capable corrections. Compass-only aiding can
still support yaw during an amber segment. GPS availability alone does not set the
uncertainty or the trend color. These are model estimates (1σ), not measured
attitude error or guaranteed bounds; fixed mounting/zero-reference error is
excluded. Local yaw uncertainty is shown separately from unknown absolute
heading; a stable relative reference does not imply true north.
Diagnostics sample once per second, retain at most 121 points, and pause while
hidden or showing the display demo. Missing motion and hidden intervals leave
gaps in the trend. Stopping or recalibrating clears the history; the display demo
does not produce simulated estimator diagnostics.

### Internal host interfaces

`getSnapshot()` / `subscribe()` expose attitude, validity and calibration wait
reasons. `readDisplaySnapshot()` reads the latest attitude between publications
without advancing the estimator or notifying subscribers. While hidden,
`getSnapshot()` retains the last published display state; use `readDisplaySnapshot()`
for a current read. A host can supply its
own controls, motion adapter and GPS source. These are internal interfaces that
may change; they are not a supported external framework API.
The estimator and `FlightAlignment` evidence gate have no UI or browser imports.
GPS timestamps are epoch milliseconds, converted to the motion adapter's
`performance.now()` seconds using `performance.timeOrigin`.

## Ground speed, altitude and vertical speed

The PFD places a **GS tape in knots** on the left of the horizon, with a smaller
**mph** reading below, and a **GPS altitude tape in feet** on the right. Both
scales scroll behind fixed readout windows, driven by the same animated values
as their mechanical digit drums. Beveled stepped windows point toward each
tape's fixed value index, with shaded glimpses of the preceding and following
values around the lowest drum. Higher digits sit in a narrower central opening
and carry independently. Nearby tape labels remain readable around the bezel.
The lowest altitude drum rolls through 00/20/40/60/80. Negative
altitudes and carries through 10,000 feet retain their sign/leading digit.

`instrument-display.ts` adapts the standalone demo's display-only smoothing.
The animation frame clock keeps the drums moving between GPS samples, with
prediction capped at 1.25 seconds. Missing/stale values clear to dashes; first
fixes, recovery and tab resumes reset the smoothing. Raw GPS and estimator
samples are unchanged. Fresh low-speed fixes still show their readings while
the attitude/HSI retain the **Low Speed** flag.

The source can supply optional `altitude` in meters through the existing GPS
port; omitted height leaves the altitude drum blank without hiding speed.
ZLayer forwards the browser's GPS altitude from its shared location watch.
This is GPS altitude, not a barometric/pressure-altitude reading.

A single **GPS V/S** readout sits below the altitude drum, showing a signed
number in **FPM**. The horizon and tapes fill the instrument width in both
toolbox and full-screen modes.

`vertical-speed.ts` fits a five-second least-squares trend to raw GPS heights
(not animated drum values or unaided IMU velocity), then applies a two-second
exponential damper. At least three distinct fixes spanning two seconds are
required. The numeric value uses 100-fpm steps with rounding hysteresis and
a small zero band; these display settings are not a reproduction of any
specific aircraft's air-data filtering. Typical response lags altitude changes
by several seconds, and accuracy depends on the GPS height measurements.
This is a GPS-derived rate, not barometric vertical speed.

Missing/stale height, reported vertical accuracy worse than 30 m, invalid
accuracy, backwards timestamps, fix gaps above 2.5 seconds, implausible height
steps (over 200 ft/s), and display resumes clear the trend and require fresh
samples. Unreported vertical accuracy remains usable. Unavailable/initializing
VSI shows a dash, never an assumed zero. Accuracy rejection
affects the VSI only; GPS altitude and GS retain their independent readings.

## Compact HSI

`AhrsTool` accepts the workspace route through its optional `route` prop. The
HSI below the attitude display uses magenta for the resolved route's desired
track and course-deviation bar. The thin course pointer spans the compass rim
from arrowhead to tail, with the moving CDI between its fixed shaft segments.
Its compass rose is centered at 80% of the toolbox content width. The heading
readout sits above the rose, with separate track and reference details underneath.
Typography uses the shared B612 UI stack and caption sizes; the full-width route-leg
selector uses the shared 14 px / 16 px touch control size.
It shows distance to the selected leg's endpoint,
TO/FROM, cross-track error (L/R is the aircraft's side of the route), and a fixed
±2 NM full-scale CDI. Great-circle calculations handle dateline crossings and
the changing local course along a leg.

### Heading and guidance behavior

The card uses a persistent AHRS-owned **HDG** reference. A supplied true heading
or aligned estimator heading takes precedence. Otherwise, usable GPS track can
establish an estimated geographic heading without waiting for full estimator
alignment. Gyros carry turns between fixes; GPS and alignment corrections settle
gradually. GPS-seeded heading is labeled **GPS/IMU** and **Estimated heading**
because ground track can differ from aircraft heading.

Heading confidence controls the warning, not whether available magenta guidance
is drawn. Each part of the HSI uses the inputs it needs:

| Situation | Heading display | Route information |
| --- | --- | --- |
| GPS is usable; estimator heading is still unverified | GPS seeds **HDG**, then gyros carry it; the **Heading** cross remains after calibration. | Fresh position and a supported route show magenta course/CDI and all route readings beneath the cross. |
| Heading becomes uncertain or the estimator reacquires alignment | Keep the geographic heading and smooth subsequent corrections. | Keep available course/CDI and route readings beneath the warning. |
| GPS is lost or speed falls below the movement gate | Keep the established geographic reference; live gyros continue turning it. | Low speed preserves guidance from a fresh position. GPS loss removes live position-based guidance, while heading remains visible. |
| Motion pauses or calibration is still in progress | Show any available geographic reference under the warning; usable GPS can still supply an estimate. Do not extrapolate missing gyro motion. | Keep guidance when its position and geographic reference are available. |
| No geographic reference has been established | Show live relative yaw as **REL**, with numeric marks and no N/E/S/W or magnetic/true suffix. | A fresh position still supplies desired track, distance, cross-track error and TO/FROM. The geographic course/CDI and track diamond cannot be oriented on a relative card. |

Stopping or starting a new calibration clears the session's reference. Stowing,
full-screen changes, GPS loss and heading recovery preserve it. GPS recovery
restores available guidance without requiring recalibration.

The session owns heading in [heading-reference.ts](heading-reference.ts) and exposes
it as `AhrsSnapshot.hsiHeading`. This provisional reference leaves the navigation
filter's heading uncertainty and fusion gates intact. Timing, damping and frame
transitions are documented in the [heading-reference design](estimator/heading-alignment.md#hsi-heading-reference).

### Route geometry and magnetic reference

The default leg is explicitly **Auto · nearest**, with a selector to choose a
supported straight route leg. Approach legs and legs with intermediate geometry
are excluded: reducing them to an endpoint-to-endpoint great circle would give
misleading guidance. Their map depiction remains available, and the HSI reports
when legs are omitted. It is a geometric route display, not a procedure navigator: it has
no turn anticipation, approach sensitivity changes, or managed flight-plan
sequencing. Editing the route immediately updates its available legs.

The compass uses **magnetic** heading whenever geographic variation is available.
The rose, **HDG … M**, **TRK … M**, and **DTK · M** all use the same local
east-positive declination (`magnetic = true − declination`). The gold heading
triangle retains its true-heading tooltip and **TRUE HDG … T** readout, and
**VAR** reports magnetic variation below the rose. The white diamond shows GPS
ground track separately, preserving the drift angle.

`AhrsTool` accepts the browsing FAA `revision`. Its optional magnetic model is
discovered through that cycle's navigation manifest on the configured chart feed.
The shared catalog `fetchMagneticModel` loader uses the existing validated JSON cache, including offline reuse
after a successful load. Opening or reconnecting retries failed loads; stowing
cancels pending requests. This does not add a model download to saved-region packs.
Hosts can also pass a validated `MagneticModel` directly to `Hsi`.

`core/geo/magnetic-model.ts`, shared with the map ruler, evaluates WMM2025 at the current GPS position, ellipsoid height
(zero if absent), and UTC date. It recomputes only when position, height, model or
day changes. The published coefficients include their annual changes and are
valid from 2025-01-01 through 2029-12-31, independently of the FAA cycle.
Missing/invalid/expired models and weak polar fields explicitly switch available
readings to **TRUE**, with a visible explanation. Both NOAA's caution zone (horizontal field
below 6000 nT) and blackout zone (below 2000 nT) use that fallback. The geographic
poles also use TRUE. Conversion does not align AHRS yaw or change calibration.

The evaluator adapts NOAA's public-domain WMM `geomag.c` recurrence and WGS84
conversion. This incorporated U.S. Government material is not subject to copyright.
Reference vectors in `test/fixtures/WMM2025_TEST_VALUES.txt` are from
[NOAA NCEI](https://www.ncei.noaa.gov/sites/default/files/2025-02/WMM2025_TEST_VALUES.txt).
The coefficient fixture is the published chart export of
[NOAA/BGS WMM2025](https://doi.org/10.25921/aqfd-sd83), retrieved 2026-09-18.

Custom GPS ports can provide optional `coordinates` as `[longitude, latitude]`;
omitting position leaves attitude support intact.
The HSI shares AHRS's GPS lease and adds no location watch.

## Calibration and validity

A GPS fix is not required to calibrate the IMU or display attitude, even if the
session has never received a fix. Once calibration completes and motion readings
remain current and uninterrupted, the attitude indicator (AI) follows these three
states:

| GPS and IMU state | Attitude indication | Red cross |
| --- | --- | --- |
| IMU calibrated and working; no GPS fix or missing/stale/unreliable GPS velocity | Visible and moving from the IMU | **No GPS** |
| IMU calibrated and working; fresh GPS below the aiding speed | Visible and moving from the IMU | **Low Speed** |
| IMU calibrated and working; usable GPS and acceptable tilt uncertainty | Visible and moving | None |

High tilt uncertainty keeps the cross even with usable GPS, labeled
**Uncertainty**. Missing GPS, low speed and growing uncertainty never hide or
freeze calibrated, live attitude. This applies to the first calibration without
GPS, later GPS loss, and prolonged operation without GPS aiding. The same policy
applies in the toolbox and full screen.

Numerical integrity and navigation validity are checked separately. If unaided
integrated velocity leaves the supported range, only navigation and its replay
history restart. Attitude, bias estimates and their full covariance marginal
remain intact; the restart neither improves the reported uncertainty nor
reapplies an initial heading. Fresh GPS can establish a new navigation reference.
Non-finite filter state or invalid covariance still requires recalibration. This
failure takes priority over a sensor pause or unusable reading: the attitude stays
hidden beneath **Calibration**, without promising automatic recovery.
The app enables automatic recovery from interrupted IMU timing: scrolling,
temporary browser stalls and returning from the background retain calibration.
While readings are missing, **Motion** marks the held last attitude. Fresh
readings resume integration without a calibration prompt.

Scrolling does not explicitly pause AHRS. Motion callbacks, estimation and the
React/SVG display run on the main thread, so a busy or suspended main thread can
delay both sensor delivery and drawing. A sensor gap above 0.5 seconds shows
**Motion** when the display next runs; if rendering itself is stalled, the warning
cannot paint until it resumes. A brief freeze is therefore possible and does not
by itself establish a memory leak. Repeated or persistent foreground freezes need
an on-device CPU/memory trace. See the [AHRS memory and scrolling](../../../docs/verification/memory-resources.md#ahrs-session-memory-and-scrolling).

With the device secured in its selected mount, the pilot confirms a roughly steady,
level pose; in flight this means straight, level flight at a steady speed, not
perfect stillness. Small movements, gentle rocking and bounded cockpit vibration
are allowed. Approximately ten seconds of observed readings estimate gyro bias and
level pitch/bank. Scrolling or a sensor pause preserves the collected readings and
shows **Paused** with the retained progress. Missing intervals above 250 ms add no
progress and no weight to the averages. Before completing, the gate requires at
least half a second of continuous readings after the latest pause and compares
their mean gravity direction with the retained readings. A difference above 5°
discards the old pose, keeps the new segment, and explains why collection continues
for a new level reference. Compatible poses retain progress; individual vibration
spikes do not determine this check. Both future rate and force samples receive the mount trim.
Missing/invalid motion and unstable IMU readings still prevent completion. Changing usable GPS velocity also blocks
calibration when it supplies evidence of a turn or acceleration.

Sample-to-sample sensor noise is checked separately from changes in half-second,
time-weighted IMU averages. The averages must stay within 1°/s gyro and
0.75 m/s² force RMS variation over the window; raw scatter is bounded at 10°/s
and 2 m/s² respectively. Mean rotation above 1°/s or gravity magnitude error
above 8% still prevents alignment. These averages only affect calibration
qualification; live propagation continues to receive every motion sample.
The overall bias, force average and scatter use observed time too, so changing
sample cadence cannot give one direction of rocking disproportionate weight.
Accepted slow motion increases the initial gyro-bias uncertainty: the prior uses
at least the half-second gyro-mean scatter rather than treating every sample as
independent noise. These are engineering acceptance limits, with synthetic
regressions for vibration and gentle ±0.8° rocking, not measured aircraft limits.

Collecting ten seconds of readings is not the same as passing calibration.
A rejected window shows **Waiting**, an incomplete progress bar, and the
specific sensor measurement and limit that failed. It does not remain at
**10 / 10 s** or assert that the device moved based solely on sensor scatter.
The rolling window continues automatically and can qualify once readings settle.

Missing, stale, inaccurate or position-derived GPS, and speed below 10 m/s
(about 20 kt), do not prevent the app's calibration from completing. Stationary
devices can calibrate too. The moving attitude then shows **No GPS** or **Low Speed**
according to the current source. Usable GPS recovery clears the GPS limitation
without repeating calibration or resetting the filter; the cross remains if tilt
uncertainty is still high.
The reusable `FlightAlignment` gate remains strict by default; the app explicitly
opts into `allowUnaided` and `pauseOnGap`. Its solution separately reports whether GPS corroborated
the calibration window (`gpsVerified`); that history does not govern the display.

The calibration gate uses horizontal GPS velocity, not the display's altitude.
Straight-and-level flight remains a pilot-confirmed assumption: the gate cannot prove level
flight, distinguish every slow turn from gyro bias, calibrate sensor scale
factors, or determine accelerometer bias from this one pose. The estimator
retains conservative bias uncertainty. Calibration and filter state do not restore
across restarts; recordings preserve diagnostics, not a resumable estimator session.

### Tilt aiding and heading acquisition

A known **true heading from an independent instrument** is optional and is used
once during calibration to initialize direction. It is never reapplied as a
continuing heading measurement. Without it, `MotionHeading` matches time-aligned
IMU and GPS velocity histories to establish direction before enabling full GPS velocity fusion.
GPS ground track is never used as a trusted nose-heading measurement in that
navigation filter; the HSI's provisional GPS/gyro reference is separate. Before north
alignment, the main filter uses the magnitude of horizontal velocity changes,
direct vertical velocity when supplied, and altitude. The horizontal factor uses
non-overlapping endpoint pairs over 2–15 seconds and preserves direction ambiguity.
It supports intermittent GPS during near-steady flight; see
[velocity-change.md](estimator/velocity-change.md).

The default estimator jointly tracks position, velocity, attitude, sensor biases,
persistent and transient world acceleration, and a relative magnetic field.
Gyros drive attitude propagation. Every fresh accelerometer sample is an
observation of gravity plus kinematic acceleration; GPS velocity constrains the
integral of that same acceleration. Both can correct simultaneously without
counting accelerometer input twice. Rejected GPS fixes cannot pause gravity aiding.

A persistent acceleration component with a slow random walk preserves
sustained-acceleration/tilt ambiguity while allowing previous acceleration
estimates to change. A separate Gauss–Markov transient models faster changes.
Its process uncertainty increases with sustained rotation, allowing maneuver
acceleration without weakening steady-flight correction by the same amount.
The rate average attenuates alternating angular vibration; it does not assert
that the aircraft is level or assign acceleration from rotation.
Quiet samples do not prove zero acceleration, and
accelerometer-bias learning requires accepted GPS evidence. See
[gravity-aiding.md](estimator/gravity-aiding.md) for the equations and assumptions.
The explicit `gravityAiding: false` option retains conventional strapdown INS
without gravity observations. The PWA forwards GPS altitude and its accuracy as
well as speed/track; receiving a fix alone does not establish navigation-filter
north alignment or active aiding, although usable track can seed the HSI reference.

Raw magnetic observations can constrain accumulated attitude drift, including
relative yaw, without GPS. Gravity alone still leaves yaw unobservable. Absolute
heading remains explicitly unknown (`attitudeStd[2] = Infinity`) until alignment;
`relativeYawStd` separately reports uncertainty in the local-frame yaw. No aid
makes mounting error, sustained acceleration or magnetic interference disappear.

The coarse alignment retains at most 20 seconds of observations, sampled at no
more than 1 Hz. It removes constant offset and linear drift, then fits a horizontal
rotation. Thus constant wind, constant speed, or constant acceleration alone cannot
create a heading estimate. At least eight observations, motion above receiver noise,
agreement in shape and scale, and three consistent estimates are required. Tilt
uncertainty must remain below 10°. A generalized least-squares fit carries the full
inter-sample inertial covariance, estimates offset/linear drift as nuisance
parameters, and includes correlation with current yaw when transporting heading.
The resulting heading standard deviation must be no larger than 20°. This is a conservative model-based gate, not a validated
accuracy bound. Missing/poor GPS and gaps restart evidence collection. The general
observability requirement is also described in
[PX4's navigation-filter documentation](https://docs.px4.io/main/en/advanced_config/tuning_the_ecl_ekf).

Once aligned, the existing ESKF applies GPS velocity corrections, including delayed
measurement replay. Alignment is not permanent: excessive heading uncertainty or
an unsupported attitude correction releases it for fresh acquisition, preserving
tilt/bias/reference estimates and their joint uncertainty. Gravity and magnetic
aids continue during recovery when their observations are usable. Rejected GPS observations can also establish a new heading
through an independent inertial trajectory and motion fit. Accepted velocity
observations end that evidence window; altitude corrections can continue without
contaminating it. Source history and current validity are reported separately.
The transition rules and covariance transfer are documented in
[heading-alignment.md](estimator/heading-alignment.md).
Coarse alignment uses only subsequent GPS fixes for velocity fusion.
Without enough heading evidence, attitude remains relative. Without a usable form
of tilt/velocity aiding, uncertainty grows. Steady IMU evidence can bound tilt
through GPS loss; heading uncertainty remains separate. The app forwards reliable GPS velocity at every speed;
the movement gate still applies to heading acquisition and the flight display warning.
Gravity/magnetic corrections, yaw-independent GPS evidence, and aligned GPS
velocity corrections constrain tilt without clamping its covariance. Receiving a fix alone does not claim active aiding.

### Relative magnetic fusion

The optional input uses platform-calibrated XYZ fields where available, with
absolute browser orientation and Safari compass fallbacks. The raw-field model
compares each vector with a persistent world reference and estimates body magnetic
bias jointly. Accepted observations can correct accumulated attitude error and
observable biases. Full-vector correction requires qualified magnetic evidence
and recent tilt aiding; calibration learning additionally requires rotation diversity.
A provisional reference must remain stable for two seconds before its current
reading seeds the reference with shared attitude covariance, so it
cannot invent north or erase preexisting alignment uncertainty.

OS-fused orientation and scalar compass readings have a separate heading-only
update using covariance intersection for unknown shared IMU errors. It can
conservatively inflate other uncertainties; it cannot directly move pitch/roll or
navigation. An update must improve attitude variance and a fixed covariance cost
including retained calibration and acceleration states. Qualified nonlinear
reacquisition is available for both raw vectors and heading-only observations.
Source switching,
field strength, innovation, geometry and accuracy checks protect the update;
rejected disturbances do not automatically replace its reference. Slowly changing
interference and orientation-dependent distortion remain limitations. Ordinary
motion gaps retain the reference, and delayed samples replay at acquisition time.

No mandatory figure-eight step is added. A constant heading offset is absorbed by
the relative reference; orientation-dependent magnetic distortion is not. Online
body-bias estimation needs sufficient motion and does not replace platform or
installation calibration. The **Uncertainty** details show local-yaw uncertainty,
source activity, accepted/rejected counts and rejection reasons. Recordings use
model identifier `kinematic-ahrs-v6` and a 30×30 joint covariance. See
[magnetic-fusion.md](estimator/magnetic-fusion.md) for the equations, browser
limitations, calibration policy, timing and validation status.

### Validity flags and device limits

For calibrated attitude with current, uninterrupted IMU readings, the cross is
shown when GPS is unavailable for aiding **or** estimated tilt uncertainty exceeds
its limit: `!gpsUsable || tiltStd > maxTiltStd`. The app's current `maxTiltStd` is
10° of model-based tilt standard deviation (1σ), not a measured error or guaranteed
accuracy bound. Unknown absolute heading alone does not trigger this tilt warning.
Usable GPS clears the cross only while tilt uncertainty is within the limit;
GPS availability and actual accepted aiding updates are reported separately.

The attitude indicator's cross label explains the current limitation:

| Label | Meaning | Recovery |
| --- | --- | --- |
| **Calibration** | Calibration is needed/in progress, sensor access failed, or the estimator is unhealthy. No attitude indication is drawn. | Restore access if needed and complete steady calibration. |
| **Motion** | Motion is paused or a reading was unusable; the last calibrated attitude is held. | Automatically resumes with fresh readings. |
| **No GPS** | Calibrated attitude continues, but fresh, reliable GPS velocity is unavailable. | Restore usable GPS. |
| **Low Speed** | Calibrated attitude continues and GPS is live, but movement is below 10 m/s (about 20 kt). | Fresh GPS above the movement gate. |
| **Uncertainty** | Calibrated attitude continues and GPS meets the movement gate, but estimated tilt uncertainty is high. | Effective GPS aiding can reduce uncertainty; recalibrate when steady. |
| No cross | Calibration and motion are valid, GPS meets the movement gate, and tilt uncertainty is within its warning threshold. | Normal display; GPS aiding status is shown separately. |

For the attitude indicator, calibration and motion faults take priority over GPS
limitations. Specific sensor problems appear in the explanatory text. The HSI
applies its own [heading and guidance rules](#heading-and-guidance-behavior).
With confident heading and available guidance, **Low Speed** appears below its
dial without crossing out the course. Estimated heading keeps the cross over the
same available guidance. The attitude indicator and HSI can therefore show
different warnings without suppressing each other's readings.
A fresh slow fix remains available in the snapshot (`gpsLive`), while `gpsUsable`
also requires sufficient movement. These are display validity gates, not guarantees
of filter observability. Accepted low-speed corrections still appear as GPS aiding
in the uncertainty diagnostics even while **Low Speed** remains over the instruments.
IMU propagation and existing calibration continue beneath
the transparent cross, processing every delivered sample. GPS loss never
resets the filter, clears its biases, or stops motion processing. GPS alone
cannot clear a motion warning; fresh IMU readings are required.
After calibration, missing GPS and prolonged outages keep the live IMU attitude
visible even when estimated tilt uncertainty exceeds its warning threshold.
The cross retains **No GPS** or **Low Speed**, with high uncertainty explained
below the instrument. If usable GPS returns before uncertainty has fallen, the
cross changes to **Uncertainty** and the horizon continues moving.

Browser motion uses the W3C XYZ angular-rate convention and selected upright
or flat mount, with the existing iOS specific-force polarity convention. These
are hardware assumptions; simulated tests do not validate a particular phone
or aircraft installation. The tool is experimental and has not been flight
validated.

Motion timestamps use DOM event creation time on the `performance.timeOrigin`
clock, including normalization of legacy epoch timestamps. Receipt time and the
reported nominal interval remain separate recording metadata. Repeated and
out-of-order timestamps are skipped because they supply no new integration interval. Ordered callbacks
can arrive late and catch up using their original event times; callback delay alone
does not discard calibration. After 500 ms without readings, the last attitude is
held beneath **Motion**. Invalid, incomplete or future-dated readings are skipped
with an explanatory message; the next valid reading clears that message. Epoch
and relative timestamps can coexist after normalization. The adapter never invents
sample times from the nominal interval.
This policy is shared by Safari and the Home Screen app. Event creation is the best
available browser proxy, **not guaranteed hardware acquisition time**.
OS/browser batching before event creation remains a device-validation requirement.

For an actual gap above 250 ms, the app's `recoverAfterGap` option starts a fresh
integration interval at the next sample, preserving attitude, mount trim and bias.
It does not extrapolate the last gyro reading across the gap or reset to level.
Navigation/replay history and heading confidence are discarded. Each attitude axis
receives additional variance corresponding to 30°/s times the missed duration,
capped at 90° per gap. This is an engineering allowance for unknown motion; it can
leave **Uncertainty** visible while the instrument continues working. Fresh
gravity and magnetic observations can constrain drift before GPS returns. The
magnetic reference persists; GPS navigation and north alignment must be rebuilt. The reusable estimator defaults to requiring a reset
on a gap unless this option is enabled; recordings include the app's actual options.
Retained sensor biases and magnetic-reference uncertainty age by their configured
random walks throughout the gap. Kinematic acceleration uncertainty ages too;
keeping the calibrated means does not keep their old confidence indefinitely.

## Verification

The recorded v6 verification passed its unit suite, import/type checks,
production build and browser/graphics checks. The original turn-accuracy,
compass-drift and layer uncertainty limits were retained. See the
[dated test results](validation.md#v6-beta-verification)
for measured errors, vibration/gap checks and remaining statistical evidence.
These checks do not substitute for recorded phone/aircraft data.

- `test/ahrs-calibration.test.ts`: stationary sensor noise, level-flight rocking and
  vibration at multiple and changing sample rates with/without GPS, measured
  rejection reasons, motion/noise bounds, retained evidence across pauses without
  counting missing time, and recovery when readings settle.
- `test/ahrs-layer.test.ts`: combined and unaided calibration, full-rate processing while stowed, motion rejection and GPS qualification,
  live indication with no fix, prolonged GPS loss or low speed even above the tilt
  uncertainty threshold, GPS recovery without resetting calibration, independent
  heading, cancellation, errors, and cleanup.
- `test/ahrs-estimator.test.ts`: independent analytic motion at 30/50/60 Hz, delayed GPS replay,
  covariance health, and calibration evidence checks.
- `test/ahrs-motion-clock.test.ts`: browser adapter event/receipt separation, epoch
  normalization, skipped timestamps, timing messages, and attitude accuracy and
  freshness under queued callback delivery.
- `test/ahrs-gap-recovery.test.ts`: repeated and long gaps, retained pose/bias,
  increased uncertainty, covariance health, rejection of GPS from the missing
  interval, and fresh GPS rebuilding tilt/heading aiding.
- `test/ahrs-mathematics.test.ts`: independent finite differences of navigation dynamics
  columns and the covariance-reset Jacobian, plus navigation-marginal NEES/GPS NIS.
- `test/ahrs-observations.test.ts`: per-source innovation diagnostics and revision
  handling when delayed observations replay existing corrections.
- `test/ahrs-heading-recovery.test.ts`: long straight legs followed by finite turns,
  repeated recovery, GPS loss/delay, wrong priors with concurrent altitude aiding,
  isolated outliers, and preserved tilt/bias covariance.
- `test/ahrs-tilt-aiding.test.ts`: no-GPS drift with vibration, persistent
  acceleration ambiguity, all-axis accelerometer correction, free fall, disabling
  gravity aiding, delayed GPS resumption, and heading acquisition after a straight leg.
- `test/ahrs-kinematic-fusion.test.ts`: coherent rotation versus alternating
  vibration, maneuver uncertainty across gaps, bounded heading-trajectory refresh,
  persistent acceleration, correlated-compass uncertainty and nonlinear recovery.
- `test/ahrs-magnetic-fusion.test.ts`: both vector Jacobians, reference covariance,
  frame invariance, no-GPS drift for each sensor source, delayed fusion, weak yaw
  geometry, disturbances, source switching, duplicate input and permission loss.
- `test/ahrs-hsi.test.ts`: course/deviation signs, nearest legs, waypoint passage,
  dateline and high-latitude geometry, magnetic/true references, unchanged CDI
  geometry, heading versus track, available guidance beneath warnings, and REL
  with position-based route readings.
- `test/ahrs-heading-reference.test.ts`: GPS initialization, gyro motion through
  north, delayed fixes, smooth corrections, retained references through recovery
  and motion pauses, manual-heading precedence, and explicit reset.
- `test/ahrs-magnetic-model.test.ts`: all 12 NOAA reference vectors, date/height
  limits, east/west signs, wraparound and coefficient validation.
- `test/ahrs-magnetic-data.test.ts`: manifest discovery, versioned loading, offline
  reuse, mixed-cycle rejection and cancellation.
- `test/ahrs-instruments.test.ts`: drum carries, animation continuity across
  frame rates, bounded prediction, missing readings, units and recovery.
- `test/ahrs-vertical-speed.test.ts`: analytic climb/descent/level trends,
  damping across frame/fix rates, noise and digit hysteresis, validity gates,
  discontinuities, and recovery without false climb indications.
- `test/ahrs-display-frames.test.ts`: 60 FPS cap across display refresh rates,
  missed-frame handling and cancellation.
- `test/ahrs-recording.test.ts`: ordered events, bounded buffering, partial sessions
  and storage-failure recovery.
- `test/gps-service.test.ts`: shared location ownership, visibility, independent
  AHRS/Ownship lifetimes, and AHRS operation without an Ownship instance.
- `test/ownship-layer.test.ts`: map demand, centering, track history and lease cleanup.
- `test/e2e/ahrs.spec.ts`: actual toolbox, motion events, HSI route selection,
  responsive instrument layouts, calibration with no GPS fix or low speed, live
  attitude beneath the cross during prolonged GPS absence and high uncertainty,
  scrolling with paused/queued sensors during and after calibration, automatic
  recovery after backgrounding or unusable readings, and recovery as GPS aiding
  reduces uncertainty.
- `test/e2e/ahrs-geometry.spec.ts`: rendered bank-pointer perpendicularity,
  circular scaling and tape clearance across bank/pitch combinations; GPS V/S
  placement and signed-digit fit at desktop/mobile widths.
- `test/e2e/ahrs-fullscreen.spec.ts`: phone, tablet-window, mini, 4:3 and larger
  tablet viewport fit in portrait/landscape, visible HSI readings/route selection,
  touch targets, retained demo/calibration/HSI state, modal focus, Escape and persistence.
- `test/e2e/ahrs-drums.spec.ts`: rendered rolling digits and altitude/speed transitions.
- `test/e2e/ahrs-recording.spec.ts`: live capture, recorder layout, offline downloads
  after reload and recovery of committed chunks after interruption or write failure.
- `test/e2e/map-edge-tools.spec.ts`: touch layouts, focus and panel bounds.
