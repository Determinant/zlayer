# AHRS methodology review — 18 September 2026

The existing error-state Kalman filter is a credible foundation. Comparing it
with current drone software does **not** establish that the complete phone AHRS
is sound or complete. The comparison identifies concrete input-handling defects,
an additional recovery dependency, and gaps in uncertainty validation. Keep the
core provisionally; address those items before deciding whether a more elaborate
heading estimator or a different filter formulation is needed.

The baseline review below changed no application algorithm. It compared source, published
methods and bounded synthetic counterexamples. It does not rerun the test suite,
run PX4/ArduPilot against Zlayer, or claim to validate a physical phone.
The implementation follow-up at the end records the subsequent fixes and checks.

## Reference implementations and papers

The upstream source snapshots inspected were PX4 main
[`c4e4ef98e9d75063bf3d53ebb2716221ee7505ae`](https://github.com/PX4/PX4-Autopilot/tree/c4e4ef98e9d75063bf3d53ebb2716221ee7505ae)
and ArduPilot master
[`9165d22419406556fc9815d9f4e3e299e13713a8`](https://github.com/ArduPilot/ardupilot/tree/9165d22419406556fc9815d9f4e3e299e13713a8),
both dated 18 September 2026. These are development snapshots, not claims about
every released or deployed controller.

| Reference | Relevant contribution | Application to Zlayer |
| --- | --- | --- |
| [Solà, *Quaternion kinematics for the error-state Kalman filter*, 2017](https://arxiv.org/abs/1711.02508), especially §§5–6 | Local quaternion errors, inertial error dynamics, error injection and covariance reset | Appropriate mathematical baseline for `eskf.ts`; not a validation of our aiding gates |
| [Mahony, Hamel and Pflimlin, *Nonlinear complementary filters on the special orthogonal group*, 2008](https://researchportalplus.anu.edu.au/en/publications/nonlinear-complementary-filters-on-the-special-orthogonal-group/) | Geometric attitude observers with gyro-bias estimation for low-cost IMUs | Useful comparison method; stability results depend on the available reference-vector measurements |
| [Barrau and Bonnabel, *The invariant extended Kalman filter as a stable observer*](https://arxiv.org/abs/1410.1465) | Convergence analysis for a specified class of invariant systems | Supports considering invariant formulations; does not prove our biased-IMU implementation converges |
| [Fornasier et al., *Equivariant Symmetries for Inertial Navigation Systems*, June 2025 revision](https://arxiv.org/abs/2309.03765v3) | Comparison of modern IMU/GNSS filters, including bias geometry and statistical consistency | Strong reference for the **evaluation methodology** before considering a replacement |
| [PX4 EKF2 guide](https://docs.px4.io/main/en/advanced_config/tuning_the_ecl_ekf) and pinned source below | Error-state navigation, delayed fusion, recovery and diagnostics | Closest practical architectural reference |
| [ArduPilot compass-less operation](https://ardupilot.org/plane/docs/common-compassless.html) and pinned source below | Operational use of IMU/GPS heading estimation without a compass | Confirms that a continuously supplied manual heading is unnecessary; accurate velocity and suitable motion still matter |

The 2025 paper's comparisons assume trajectories with sufficient observability.
Its UAV simulations use 200 Hz IMU and 10 Hz position measurements, so its numerical
results do not transfer directly to browser motion events and speed/track fixes.
It evaluates actual errors and normalized estimation-error energy across 400
runs, then compares against recorded UAV data. That is a more useful standard for
our next validation stage than selecting whichever filter has the newest name.
[Full paper](https://arxiv.org/html/2309.03765v3)

## Similar IMUs do not imply identical measurement streams

The comparison is relevant to consumer MEMS technology. However, the particular
phone's IMU and OS processing have not been identified. For example, Holybro's
current comparison lists triple ICM-45686 IMUs and temperature control for the
Pixhawk 6X, and two IMUs for the 6C. Redundancy and the measurement interface are
part of the system, beyond the sensor chip itself.
[Manufacturer specification](https://docs.holybro.com/autopilot/controller-comparison)

PX4 documents timestamped delta-angle/delta-velocity inputs, coning compensation
and a delayed fusion horizon. Zlayer instead receives browser angular-rate and
acceleration events. Correctly handling those events is a prerequisite for
applying the same estimation mathematics.
[PX4 input requirements](https://docs.px4.io/main/en/advanced_config/tuning_the_ecl_ekf#imu)

The current W3C specification maps motion `alpha`, `beta`, `gamma` to X, Y, Z
angular rates; the inspected adapter follows that specification. This must not
be confused with the different orientation-Euler-angle convention. Browser and
mount/polarity behavior still needs physical verification.
[W3C motion specification](https://www.w3.org/TR/orientation-event/#devicemotion-event)

## What is already aligned with established methods

Code inspection of [eskf.ts](../../src/layers/ahrs/estimator/eskf.ts) finds the
expected local/right error structure: body-to-navigation quaternion propagation,
separate accelerometer/gyro biases, velocity sensitivity `-R[f]×` to attitude
error, attitude sensitivity `-[ω]×` and `-I` to gyro error/bias, and quaternion
error injection followed by a reset Jacobian. These signs and conventions agree
with the fixed-gravity specialization of Solà's derivation. The update uses
Cholesky solves and Joseph covariance form. This is a structural review, not a
formal proof or an independent numerical verification of every Jacobian.

The acquisition-time replay in [ahrs.ts](../../src/layers/ahrs/estimator/ahrs.ts)
is a legitimate approach to delayed observations. Its usefulness depends on the
adapter actually supplying timestamps in the declared acquisition-time domain.

Heading source is now separate from validity. Manual heading is a one-time input;
unknown yaw does not by itself stop qualified tilt aiding or GPS track guidance.
The covariance projection at heading release preserves the linearized down-direction
and bias marginals. That algebraic property does not establish the statistical
consistency of the complete acquire/track/recover sequence.

Current PX4 source also has an optional gravity-vector aiding path with acceleration,
clipping and horizontal-aiding conditions. Therefore it would be inaccurate to
describe every drone estimator as refusing all accelerometer-based tilt correction.
Our GPS-qualified `SteadyTilt` model has different assumptions and requires its
own validation.
[PX4 gravity fusion](https://github.com/PX4/PX4-Autopilot/blob/c4e4ef98e9d75063bf3d53ebb2716221ee7505ae/src/modules/ekf2/EKF/aid_sources/gravity/gravity_fusion.cpp)

## Findings from applying those methods

### 1. High priority: stowed operation discards inertial information

[layer.ts:158](../../src/layers/ahrs/layer.ts#L158) selects individual samples at
30 Hz when the toolbox is stowed. It does not integrate or filter the discarded
measurements before reducing the rate. High-frequency motion can consequently
appear as a persistent rotation.

The probe feeds the **actual layer** the same 120 Hz stream: a 30 Hz pitch
oscillation with 10°/s rate amplitude, lasting four seconds after calibration.
The true pitch amplitude is only about 0.053°, and final pitch is zero.

| Path | Estimated final pitch | Reported tilt σ |
| --- | ---: | ---: |
| Visible, all delivered samples | −0.083° | 3.252° |
| Stowed, selected 30 Hz samples | 39.667° | 3.252° |

This is a synthetic aliasing counterexample, not a measurement of a phone's
actual vibration spectrum. It demonstrates that the software can manufacture
large attitude error from a valid input sequence without reflecting it in uncertainty.
Preserve all available IMU increments; reduce display/status publication separately.
If estimator-rate reduction is necessary, derive a proper integration/filtering
stage, including the rotation-order effects of coning and sculling where relevant.

### 2. High priority: receipt time is treated as acquisition time

[motion.ts:23](../../src/layers/ahrs/motion.ts#L23) timestamps measurements using
`performance.now()` inside the callback. The estimator contract instead says
timestamps are acquisition times. Raw `event.timeStamp` and `event.interval` are
recorded but not used for propagation timing.

A second probe keeps every IMU sample and applies a monotonic synthetic delivery
delay varying between 10 and 50 ms. A two-Hz pitch oscillation with 20°/s rate
amplitude returns to level after ten seconds:

| Timestamp supplied to the estimator | Final pitch | Tilt σ |
| --- | ---: | ---: |
| Acquisition time | Approximately 0° | 3.046° |
| Callback receipt time | 25.087° | 3.046° |

The chosen delay is correlated with the motion to expose the failure; this is
not an estimate of ordinary browser error. Integration against a distorted time
axis is the underlying problem. GPS replay cannot repair incorrectly timed IMU
propagation.

Use a documented sample-clock policy, distinguish receipt/event/sample times,
and validate queueing and sample-loss behavior per supported browser. Blindly
replacing `performance.now()` with `event.timeStamp` is insufficient: DOM event
creation time is not a guaranteed hardware sampling timestamp. The motion API's
`interval` supplies additional timing information but cannot alone identify dropped
samples. [DOM event timing](https://dom.spec.whatwg.org/#dom-event-timestamp),
[motion interval](https://www.w3.org/TR/orientation-event/#devicemotion-event)

### 3. Recovery still depends on the main filter's accepted measurements

PX4 and ArduPilot maintain a separate yaw-estimation trajectory using IMU and GPS
velocity. They do not require the main navigation filter to reject every other
measurement before gathering yaw evidence.
[PX4 yaw estimator](https://github.com/PX4/PX4-Autopilot/blob/c4e4ef98e9d75063bf3d53ebb2716221ee7505ae/src/modules/ekf2/EKF/yaw_estimator/EKFGSF_yaw.cpp),
[ArduPilot prediction/correction](https://github.com/ArduPilot/ardupilot/blob/9165d22419406556fc9815d9f4e3e299e13713a8/libraries/AP_NavEKF3/AP_NavEKF3_Control.cpp#L816)

Zlayer's [rejected-update recovery path](../../src/layers/ahrs/estimator/ahrs.ts#L376)
clears its heading window after **any** accepted navigation correction. This is
necessary while it uses the main filter's velocity, but leaves a dependency:
valid altitude aiding can prevent recovery from a bad horizontal alignment.

A probe deliberately supplies a 90° wrong heading with an overconfident 10° prior,
precise GPS and a finite crosswind turn. This tests a faulty prior, not the already
fixed case of correct manual heading followed by 15 minutes of drift.

| Generic estimator input | Result after 60 s |
| --- | --- |
| Horizontal GPS velocity only | Reacquires at 15 s; heading error 0.077° |
| Same velocity plus valid constant altitude | No reacquisition; heading error 85.264°, reported heading σ 10.093°, 55 rejected velocity updates |

Roll/pitch error remains small in this probe. Also, the **current application
deliberately forwards null altitude** to the estimator, so the altitude-triggered
failure concerns the generic estimator API and future aid combinations. It is
not evidence of this exact failure in today's app path.

The transferable design principle is independent recovery evidence. A separate
inertial trajectory may be enough for our existing whole-circle motion fit; a
GSF is one candidate, not yet a demonstrated necessity. Do not simply feed
GPS-corrected main-filter velocities into the fit or remove the evidence reset.

### 4. The custom aiding uncertainty remains an unverified model

The `MotionHeading` noise/tilt/bias formula and `SteadyTilt` acceleration allowance
are application-specific approximations. Disjoint windows prevent one clear form
of double counting, but do not prove that the fitted heading is statistically
independent of the retained tilt/bias errors. Nor do successful scenarios validate
the stated 1σ coverage under OS filtering, receiver correlation or temperature drift.

Current PX4 additionally handles heading observability and bad/clipped accelerometer
data explicitly in covariance management. Those are useful audit targets, not
instructions to copy its numeric limits into Zlayer.
[PX4 covariance handling](https://github.com/PX4/PX4-Autopilot/blob/c4e4ef98e9d75063bf3d53ebb2716221ee7505ae/src/modules/ekf2/EKF/covariance.cpp#L113)

The existing analytic trajectories, delayed-fix tests and correlated-noise tests
provide useful regression coverage. What is missing is a statistical consistency
evaluation across trajectories, independently sampled priors and sensor errors,
including transitions. Full-state consistency checks must respect the frame and
unobservable directions: unknown absolute yaw is not a zero-variance known heading.

### 5. Logging is a foundation for validation, not the validation itself

Our recorder captures raw inputs, decisions, states and covariance. There is no
completed differential replay runner or phone/reference dataset in this review.
The single aggregate `fusion.nis` also lacks the innovation vectors and covariance
needed for whitening and temporal-correlation checks; altitude can overwrite it
in generic-API use. Record per-observation innovation, covariance, dimension,
acceptance decision and mode transitions when building that evaluator.

PX4's replay workflow supports comparing estimator changes on the same recorded
inputs. Apply that methodology using recordings begun before calibration, since
our mid-flight header is not a complete estimator checkpoint.
[PX4 replay](https://docs.px4.io/main/en/debug/system_wide_replay),
[Zlayer recording contract](../../src/layers/ahrs/recording.md)

## Recommended sequence

1. Correct IMU preservation and timing. Keep the ESKF and current permissive
   calibration behavior; a manual heading must remain optional and one-time.
2. Build deterministic replay of the recorded adapter/layer/filter path, including
   delayed GPS, visibility, skipped samples and recalibration. Compare the same
   inputs against a configured reference estimator; matching it is evidence, not truth.
3. Derive or conservatively bound the custom aiding covariance and its correlations.
   Check invariance under frame changes and absence of false yaw information in
   unobservable motion. Verify analytic Jacobians against independent perturbations.
4. Evaluate actual attitude/bias errors, innovation consistency, uncertainty coverage,
   false aiding and recovery latency across repeated trials. Include long cruise,
   slow/shallow turns, stronger maneuvers, constant acceleration, crosswind, bias
   changes, correlated GPS errors, timing jitter, dropouts, vibration and visibility.
   Use observable marginals for relative-mode consistency tests; conservative model
   allowances need coverage assessment rather than forcing every NEES value to one.
5. Replay physically recorded phone motion against an independent attitude reference,
   covering supported mounts, browsers, heat and vibration. Identify noise and latency
   parameters from those recordings. Extra drone sensors, such as true airspeed,
   must be explicitly disabled or supplied in any reference comparison. GPS ground
   speed is not a substitute for true airspeed in centripetal compensation.

The last distinction is visible in PX4's auxiliary yaw filter: it contains optional
true-airspeed-based turn compensation, complementary tilt corrections and its own
bias handling. Porting only its heading equations would omit important assumptions.
[PX4 auxiliary attitude propagation](https://github.com/PX4/PX4-Autopilot/blob/c4e4ef98e9d75063bf3d53ebb2716221ee7505ae/src/modules/ekf2/EKF/yaw_estimator/EKFGSF_yaw.cpp#L177)

## Reproduce the bounded probes

```sh
node --import=tsx tools/ahrs-review-probes.ts
```

The script prints the three paired comparisons above. It uses no physical sensors,
external application, network or persistent recording storage. Its outputs document
counterexamples, not a full regression suite or proof of operational accuracy.

## Implementation follow-up

The ESKF formulation remains. These changes address the demonstrated defects
without relaxing the existing heading-fit, correction-size or steady-tilt gates:

- The layer integrates every delivered IMU sample, independent of toolbox
  visibility. In the same aliasing probe, visible and stowed results now both
  finish at −0.083° pitch, versus the previous stowed 39.667°.
- `MotionClock` normalizes event timestamps to the shared monotonic clock and
  keeps receipt time separate. The queued-delivery regression now finishes near
  zero pitch; the old receipt-time counterexample remains in the probe for comparison.
  Missing/bad timestamps cannot silently become receipt times or guessed intervals.
  Motion faults latch until recalibration; a later valid callback cannot erase them.
  DOM creation time still does not establish physical hardware sampling time.
- `HeadingTrajectory` propagates an independent IMU trajectory and covariance.
  Accepted main-filter altitude corrections cannot modify its heading evidence.
  Accepted velocity measurements clear that evidence to prevent GPS reuse.
  The wrong-90°-prior probe now recovers at 15 seconds with or without altitude;
  final yaw error is about 0.07–0.08°, with tilt error below 0.5° at the end.
- Velocity and altitude correction counts/NIS are separate. Recorded observations
  include residual, full innovation covariance, dimension, gate and result.
  Replay revisions are explicit and replace earlier observations in analysis.
- `tools/ahrs-replay.ts` replays recorded estimator inputs from calibration
  solutions, preserving receipt ordering, acquisition times, trim and one-time
  heading. A real layer/recorder round trip reproduces attitude and covariance
  exactly. It rejects missing initialization and sequence gaps.

Independent matrix-based finite differences check all 15 dynamics columns at
multiple orientations and the SO(3) reset Jacobian near zero and at finite
corrections. A deterministic 128-trial, one-second stationary/constant-velocity
experiment samples the modeled priors, IMU white noise, bias walks and GPS noise.
Its normalized full-state NEES is **0.989** and normalized GPS NIS is **1.014** over
640 observations. This supports consistency in that tested local tracking regime;
it does not prove global acquisition/recovery consistency or identify phone noise.

The focused existing flight simulations still cover long cruise, delayed GPS,
crosswind, lost GPS, bias changes, repeated recovery and inappropriate tilt-aiding
rejection. Calibration without GPS and the live cross-state display policy remain
unchanged. No comparison against a running PX4/ArduPilot estimator or physical
reference dataset has been completed; those remain evidence needed for a parity claim.

Validation for this follow-up: 115 distinct focused unit tests passed across the
changed input, layer, recorder/replay, estimator, aiding, recovery and mathematics
paths. The offline recorder browser test (including its production build),
`npm run check`, and whitespace checks passed. The full application test suite
was not rerun.
