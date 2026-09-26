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

These are the recorded 2026-09-20 v6 results, not tests rerun during documentation
cleanup. The source/math review at `87a02e6` identified no new release-blocking
implementation defect; it did not execute additional tests or establish sensor
accuracy. The default kinematic model's broader statistical limits above remain.

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

That verification recorded **961 unit tests** (844 root, 16 contracts, 101 domain),
import/type checks, production build and zero production dependency audit findings.
Browser evidence recorded **306 Chromium cases**, including a corrected visibility
case on a focused rerun; the graphics matrix recorded **32 Firefox** and **64
WebKit/2× WebKit** passes, with three intentional native-multitouch skips on those
engines. These are dated counts, not a claim that today's combined suite passes.

Regressions include three-minute vibration at 30/60 Hz, coherent versus alternating
rotation, uncertainty through maneuver gaps, bounded heading-trajectory age, long
heading recovery and exact delayed replay. Recordings identify the equations as
`kinematic-ahrs-v6` with 30×30 covariance. Older models remain downloadable but
require their original estimator for exact replay; the current replayer rejects
incompatible models.

## v7 vibration and HSI regressions

The 2026-09-25 working-tree change adds scatter-dependent force observation
variance, averaged qualification of gravity reacquisition, and an angular-excursion
calibration check. The synthetic mount case in `test/helpers/ahrs-motion.ts` has
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

For this change, `npm run check` and all 275 AHRS unit tests passed, followed by
the two added bank-with-vibration cases (277 distinct unit cases in total).
All 41 Chromium cases in `test/e2e/ahrs.spec.ts` passed against the production
fixture build. The new browser case starts vibration before calibration, then
checks another simulated minute of displayed attitude within 3° and an uncrossed,
amber-labeled estimated HSI. This focused run is not full repository CI or device
release verification.

These synthetic and browser regressions do not establish canopy-mount performance.
Recordings from before engine start/calibration through engine-running vibration,
with an independent attitude reference, remain needed to assess real drift,
sampling aliasing, rectification, clipping and uncertainty coverage. v7 recordings
require the matching estimator; v6 history above remains historical evidence.

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
