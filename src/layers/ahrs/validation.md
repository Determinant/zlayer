# AHRS validation

[Documentation](../../../docs/README.md) / Plugins / [ahrs](README.md)

The experimental AHRS uses the quaternion error-state estimator documented in the
[feature guide](README.md) and its estimator notes. This page owns
the validation criteria, recorded numerical evidence and remaining evidence gaps.
Implementation, static review, numerical regression and physical-device validation
are separate claims. Historical passing runs do not certify a later working tree.

## Estimator invariants

- Use one body/world/quaternion convention across sensors, propagation, measurement
  Jacobians, correction injection and covariance reset.
- Count each observation once. Represent or conservatively bound shared IMU,
  OS-heading and heading-fit errors.
- Preserve finite, symmetric, positive-semidefinite covariance through restricted
  gains, source changes, frame changes and nonlinear recovery. Do not clamp
  covariance to manufacture confidence.
- Iterated recovery uses one fixed prior and commits one state/covariance update.
  Failed candidates leave live attitude and calibration means unchanged.
- Relative magnetic observations cannot establish absolute north. GPS track is
  not yaw; unknown alignment remains unknown.
- Rejected measurements do not claim active aiding. One optional aid's failure
  must not suppress valid evidence from another.
- Calibration means change only when observable. Frozen means retain uncertainty
  and cross-covariance; missing intervals age uncertainty without invented motion.
- Delayed-event replay reproduces chronological updates within retained history,
  including reference, qualification and auxiliary process state. Alignment
  boundaries explicitly restart navigation/history.
- Diagnostics describe the actual estimator state. Reported uncertainty is not a
  substitute for comparing attitude with independent truth.

## Input and recovery requirements

The layer processes every delivered IMU sample while visible or stowed; display
and status publication can be throttled independently. Selecting isolated samples
without integration/filtering can alias vibration into persistent rotation.

`MotionClock` normalizes event timestamps to the monotonic clock and records callback
receipt time separately. Missing or invalid times cannot silently become receipt
times or guessed sample intervals. DOM event creation is a browser timing proxy,
not guaranteed hardware acquisition time. Physical batching, mount polarity and
orientation conventions still require device checks. Motion rates and orientation
Euler angles use different conventions; see the [motion specification](https://www.w3.org/TR/orientation-event/).

Heading recovery uses an independent inertial trajectory. Main-filter altitude
corrections cannot reset its horizontal heading evidence, and GPS evidence shared
with other updates must not be counted again independently. Magnetic startup uses
a provisional reference distinct from an established one; healthy returning input
needs a qualified recovery path without treating an innovation rejection as proof
that the field is trustworthy. Provider changes retain the joint uncertainty model
and cannot repeatedly inflate unrelated covariance without a cost bound.

Current equations and transitions live in the
[gravity/acceleration](estimator/gravity-aiding.md),
[magnetic fusion](estimator/magnetic-fusion.md),
[heading alignment](estimator/heading-alignment.md) and
[yaw-independent velocity-change](estimator/velocity-change.md)
notes. The earlier bias-only magnetic-aiding design is superseded; its old test
results must not be used as validation of vector fusion.

## Remaining validation work

1. Extend Monte Carlo consistency checks to the default kinematic/gravity/magnetic
   combination, acquisition, provider transitions and recovery. The existing
   NEES/NIS test exercises conventional strapdown propagation and GPS. Its dated
   128-trial local tracking result was normalized NEES **0.989** and GPS NIS
   **1.014** over 640 observations; this does not establish consistency of the
   complete default estimator.
2. Evaluate actual attitude/bias error, uncertainty coverage, innovation correlation,
   false aiding and recovery latency across independently sampled priors and sensor
   errors. Include long cruise, shallow/strong turns, sustained acceleration,
   crosswind, bias changes, correlated GPS, timing jitter, dropouts and vibration.
   Use observable marginals in relative mode; unknown yaw is not a zero-error,
   zero-variance north observation. Fix assumptions and acceptance limits before
   seeing results, and report error and uncertainty together.
3. Collect phone recordings with independent attitude truth across supported mounts,
   browsers, temperature and vibration. Acceleration time scales, rotation-dependent
   diffusion and OS-heading uncertainty allowances are engineering models. Persistent
   acceleration, correlated noise and slowly changing magnetic interference can
   violate them. A figure-eight gesture or relative angular differencing alone does
   not establish hard/soft-iron calibration.
4. For a PX4/ArduPilot comparison, replay the same timestamped inputs with equivalent
   sensors and configuration. No running reference-estimator comparison or physical
   reference dataset was completed by these reviews. Extra sensors such as true
   airspeed must be explicitly supplied or disabled; GPS groundspeed is not a
   substitute for true airspeed in turn compensation. Reference agreement is
   evidence, not independent truth or a percentage of avionics equivalence.

Device permission, suspension, foreground recovery and combined-resource checks
remain in [deployment readiness](../../../docs/development/deployment.md#verification-and-remaining-release-gates).
For scrolling freezes and retained buffers, see
[AHRS memory and scrolling](../../../docs/verification/memory-resources.md#ahrs-session-memory-and-scrolling).

## v6 beta verification

The September 20, 2026 v6 numerical baseline predates the v7 vibration changes
below. Retain it for the original turn, compass-drift and uncertainty limits;
it does not establish current sensor accuracy or resolve the statistical gaps
in [remaining validation work](#remaining-validation-work).

The v6 corrections added coherent-rotation-dependent acceleration process noise,
retained turn evidence while delayed GPS completes heading qualification, and gated
OS magnetic jumps before covariance-intersection weighting. Original performance
limits were retained:

| Scenario | v5 | v6 | Acceptance limit |
| --- | --- | --- | --- |
| Delayed-GPS manual-heading turn, peak roll error at 30/50/60 Hz | 0.555–0.576° | 0.126–0.159° | <0.5° |
| Ideal automatic-heading turn, peak roll error | 2.493° | 0.673° | <1° |
| Two-minute OS-compass yaw error, no GPS | about 5.07° | about 3.34° | <5° |
| Same OS-compass scenario, tilt standard deviation | about 11.92° | about 7.90° | <10° |
| Steady IMU, missing/lost/slow GPS, open/stowed layer | Six failures | All six passed | <6° |

Regressions include three-minute vibration at 30/60 Hz, coherent versus alternating
rotation, uncertainty through maneuver gaps, bounded heading-trajectory age, long
heading recovery and exact delayed replay. Recordings identify the equations as
`kinematic-ahrs-v6` with 30×30 covariance. Older models remain downloadable but
require their original estimator for exact replay; the current replayer rejects
incompatible models.

## v7 vibration and HSI regressions

The September 25, 2026 comparison evaluates v7's scatter-dependent force
observation variance, averaged qualification of gravity reacquisition, and
angular-excursion calibration check. The synthetic mount case in `test/helpers/ahrs-motion.ts` has
±0.3° roll oscillation at 8.3 Hz, zero-mean force amplitudes of 5, 5 and 2.5 m/s²
at 11.7, 9.1 and 7.3 Hz, and small gyro offsets. These frequencies are below Nyquist
at both tested rates. They are chosen stress inputs, not measured canopy vibration.

Starting from a quiet level reference, 60 seconds of these samples and steady
1 Hz GPS produced the following peak absolute roll/pitch readings:

| Sample rate | v6 before this change | v7 | Regression limit |
| --- | --- | --- | --- |
| 30 Hz | 21.34° | 1.47° | <2° |
| 60 Hz | 17.19° | 1.77° | <2° |

The calibration regression also qualifies this vibration at 30/60/120 Hz without
absorbing it into trim or mean bias. Counterexamples retain rejection for sustained
rotation, changing half-second means, large angular wandering, extreme raw scatter
and inconsistent gravity. Missing-time and changed-pose checks remain intact.
Tests cover delayed-GPS replay with identical final quaternion/covariance and
post-gap gravity recovery while this vibration continues. Superimposing the same
mount motion on an analytic 25° banked turn at 30/60 Hz keeps peak roll/pitch error
below 3°, checking that the vibration weighting still follows a sustained bank.
Existing maneuver and heading accuracy bounds were retained.

The HSI now distinguishes a usable GPS/gyro display estimate from verified heading.
Fresh GPS, live calibrated motion and acceptable tilt permit an amber **Estimated
heading** label without a failure cross. Unknown north remains infinite in the
estimator; GPS loss, low speed, motion faults and degraded tilt retain their warnings.
No-route guidance is a text caution rather than a failed compass.

The browser regression in `test/e2e/ahrs.spec.ts` starts vibration before
calibration, then checks another simulated minute of displayed attitude within
3° and an uncrossed, amber-labeled estimated HSI. This checks integration of the
estimator and display; it does not measure device accuracy.

These synthetic and browser regressions do not establish canopy-mount performance.
Recordings from before engine start/calibration through engine-running vibration,
with an independent attitude reference, remain needed to assess real drift,
sampling aliasing, rectification, clipping and uncertainty coverage. v7 recordings
require the matching estimator; v6 history above remains historical evidence.

## Regression coverage

This inventory describes the checks and their scope; it does not assert a current
passing run. Recorded results and their limitations remain above.
For SVG instruments, distinguish path attachment/geometry from a visibility check
that requires a nonzero bounding box. Uncertainty-trend assertions must follow
actual aiding state; GPS loss alone does not imply gravity aiding has stopped.

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

## Reproduce and extend the evidence

```sh
npm run verify
node --import=tsx --test test/ahrs-*.test.ts
node --import=tsx tools/ahrs-review-probes.ts
npm run test:browser -- test/e2e/ahrs.spec.ts
```

The bounded probes compare visible/stowed sampling, acquisition/receipt timing
and heading recovery with/without altitude. Their synthetic counterexamples are
diagnostic comparisons, not an accuracy specification. The original follow-up
removed the stowed aliasing and altitude-blocked recovery; the receipt-time
counterexample remains deliberately available for comparison.

The [recording and replay contract](recording.md) describes
`tools/ahrs-replay.ts`, initialization requirements and observation diagnostics.
Capture from before calibration, preserve per-observation residuals/innovation
covariance/dimension/acceptance and replay revisions, and do not infer a complete
checkpoint from a mid-flight header. For cross-engine execution use the
[browser verification guide](../../../docs/development/local-development.md#verification).

## Method references

The methodology review inspected PX4
[`c4e4ef9`](https://github.com/PX4/PX4-Autopilot/tree/c4e4ef98e9d75063bf3d53ebb2716221ee7505ae)
and ArduPilot
[`9165d22`](https://github.com/ArduPilot/ardupilot/tree/9165d22419406556fc9815d9f4e3e299e13713a8)
on 2026-09-18. These are pinned development snapshots, not a comparison against
every released controller. Similar MEMS hardware does not imply equivalent input
streams: browser events differ from timestamped integrated inertial increments.

| Reference | Use in validation |
| --- | --- |
| [Solà, quaternion kinematics for the ESKF](https://arxiv.org/abs/1711.02508) | Local error conventions, injection and covariance reset. |
| [Mahony, Hamel and Pflimlin, nonlinear complementary filters](https://researchportalplus.anu.edu.au/en/publications/nonlinear-complementary-filters-on-the-special-orthogonal-group/) | Geometric observer comparison under its reference-vector assumptions. |
| [Barrau and Bonnabel, invariant EKF](https://arxiv.org/abs/1410.1465) | Convergence arguments for the specified invariant system, not a proof for this implementation. |
| [Fornasier et al., equivariant inertial-navigation symmetries](https://arxiv.org/abs/2309.03765v3) | Error/consistency evaluation methodology; its UAV measurement rates do not transfer directly to phones. |
| [PX4 EKF2 guide](https://docs.px4.io/main/en/advanced_config/tuning_the_ecl_ekf), [replay workflow](https://docs.px4.io/main/en/debug/system_wide_replay) | Input handling, delayed fusion, recovery and same-input comparisons. |
| [ArduPilot compass-less operation](https://ardupilot.org/plane/docs/common-compassless.html) | Independent IMU/GPS heading evidence and its observability limits. |
