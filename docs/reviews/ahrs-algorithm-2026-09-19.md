# AHRS algorithm revisions

## Fresh v6 code review — 2026-09-20

**Verdict: suitable for the current beta; no new release-blocking implementation
defect identified.** This is a source/math review of the estimator at `87a02e6`,
including all estimator modules, motion/magnetic adapters, calibration, layer
integration and recording replay. It does not claim that every sensor-error model
or operating condition has been validated. No estimator code or tuning changed,
and no additional tests ran in this pass; executed evidence is recorded below.

The review traced these invariants through their callers:

- Quaternion propagation, force/magnetic Jacobians, correction injection and
  reset use the same body-right error convention. Device mount and calibration
  trim apply consistently to force, gyro and magnetic reference vectors.
  Motion-rate XYZ mapping and orientation's separate Z-X′-Y″ sequence agree with
  the [W3C definitions](https://www.w3.org/TR/orientation-event/).
- The default gyro-driven process consumes force only through the three-axis
  acceleration observation. GPS constrains the same acceleration/velocity state;
  the independent heading trajectory receives no main-filter corrections.
- Joseph updates, restricted gains, stochastic cloning, reference initialization
  and frame changes retain their joint covariance treatment. Nonlinear recovery
  relinearizes one fixed prior and commits once. CI candidates include the cost
  of nuisance-state inflation; rejected candidates do not change live means/P.
- Startup, continuation and recovery have distinct magnetic qualification paths.
  Missing intervals age uncertainty without integrating invented motion. Delayed
  input replays the estimator's reference, acceleration-rate and qualification
  state. Alignment boundaries deliberately restart navigation/history.
- Relative yaw remains separate from north alignment. GPS track is not assigned
  to yaw. The unaligned velocity-change factor retains direction ambiguity and
  uses disjoint receiver endpoints. Displayed aiding depends on accepted evidence.

Two algorithm-validation limits remain explicit. First, acceleration time scales,
rotation-dependent diffusion and OS-heading uncertainty allowances are engineering
models; persistent acceleration, correlated noise or slowly changing interference
can violate them. Second, the Monte Carlo NEES/NIS case in
`test/ahrs-mathematics.test.ts` exercises conventional strapdown propagation and
GPS. The default kinematic/gravity/magnetic combination has scenario, Jacobian,
covariance and replay regressions, but not equivalent Monte Carlo consistency
coverage. Neither point demonstrates a new code defect. The next evidence should
come from broader statistical checks and sensor recordings with independent truth.

The only correction from this pass is documentation: the velocity-change note
still said its tests had not run, despite the completed v6 verification.

## v6 beta verification

The remaining v5 deployment-test failures were resolved without changing their
performance limits. Focused algorithm changes address the measured causes:

- **Acceleration process noise follows coherent rotation.** A fixed diffusion
  traded steady-flight drift correction against turn tracking. Quiet-flight
  diffusion is now 0.6 m/s²/√s, with an additive maneuver allowance derived from
  a 0.5-second average of bias-corrected gyro rate. Rotation raises uncertainty
  about translational acceleration; it does not assign acceleration or attitude.
  The persistent acceleration state and complete covariance remain. See the
  [equations and assumptions](../../src/layers/ahrs/estimator/gravity-aiding.md).
  Replay copies the rate average, navigation restarts retain it, and gap aging
  retains the last maneuver noise rather than assuming missing samples were quiet.
- **Heading refresh retains turn evidence.** The unconditional 30-second refresh
  could discard a useful turn before delayed GPS completed qualification. Quiet
  trajectories still refresh after 30 seconds; recent coherent rotation permits
  ten seconds for delayed fixes/confirmation, with a hard 60-second trajectory
  age cap. Fit gates, uncertainty checks and three-confirmation qualification are
  unchanged. The noisy 1.8-second GPS cadence/1.1-second delay case now acquires
  heading 14.72 seconds after turn entry, versus 30.92 seconds before this fix.
- **OS magnetic jumps are gated before CI weighting.** The scalar innovation
  variance is bounded by `(sqrt(H P Hᵀ) + sqrt(R_relative))²` before posterior
  CI weights are tried. Inflated CI noise cannot quietly loosen the field-jump
  gate. Both OS providers have rejection regressions that retain the original
  attitude and covariance; broad-prior qualified recovery still passes.

The recording model is `kinematic-ahrs-v6`. Covariance remains 30×30; v5 recordings
are explicitly rejected for replay with the changed equations. Earlier recordings
remain downloadable and need their original estimator revision for exact replay.

Measured against the unchanged regression scenarios:

| Scenario | v5 | v6 | Existing limit |
| --- | --- | --- | --- |
| Delayed-GPS manual-heading turn, peak roll error at 30/50/60 Hz | 0.555–0.576° | 0.126–0.159° | <0.5° |
| Ideal automatic-heading turn, peak roll error | 2.493° | 0.673° | <1° |
| Two-minute OS-compass yaw error, no GPS | about 5.07° | about 3.34° | <5° |
| Same OS-compass scenario, tilt standard deviation | about 11.92° | about 7.90° | <10° |
| Steady IMU, missing/lost/slow GPS, open/stowed layer | Six failures | All six pass | <6° |

`npm run verify` passes: **844 root tests, 16 contracts tests, 101 domain tests**,
import-boundary/TypeScript checks, and production build. `npm audit --omit=dev`
reports zero vulnerabilities. Added checks cover angular plus linear vibration
at 30/60 Hz for three minutes, coherent versus alternating rotation, covariance
through a maneuver gap, bounded heading-trajectory refresh and v5 replay refusal.
The long heading-recovery cases and exact delayed replay checks also pass.
Browser tests now allow the correlated OS compass to pass its two-minute drift
window before requiring accepted fusion, while preserving the abrupt-field-jump
rejection check. Stale status-text assertions now expect active gravity aiding.
The visibility regression now checks the initial gap-induced uncertainty and its
recovery after fresh readings, instead of requiring that warning to persist after
one second of correction. The two prolonged GPS-loss browser cases retain their
virtual duration and 6° bound, with a 120-second wall timeout for slower hosts.

Browser verification passes **306 Chromium cases**: 253 general application
cases, 52 AHRS cases in the complete run, and the corrected visibility case on
its focused rerun. The graphics matrix passes **32 Firefox and 64 WebKit/2×
WebKit cases**; three Chromium-only native-multitouch cases are intentionally
skipped on those engines. No unresolved test failures remain. The numerical,
static and production-build checks also passed.

This closes the demonstrated numerical failures; it does not establish
equivalence to a particular avionics estimator or replace recorded flight data.

## v5 beta implementation pass

The four findings below now have code changes and regression sources. Subsequent
deployment verification exposed the failures recorded below; numerical acceptance
is incomplete. This is not a claim of PX4-equivalent performance or a numerically
verified release candidate. The archived v4 review follows to preserve the
concrete reasons for this bounded pass.

| Finding | Implemented resolution | Regression source |
| --- | --- | --- |
| Startup reference poisoned by first sample | A separate provisional datum must remain stable for two seconds/four samples; inconsistency restarts it without touching live covariance. | `test/ahrs-magnetic-fusion.test.ts`: disturbed first strength/direction, protected established reference |
| Magnetic-only outage blocked by linear NIS | Outage/recovery eligibility precedes the ordinary raw gate; qualified IEKF retains the actual prior and physical gates. | Same file: broad-prior recovery and tight-prior rejection, scalar recovery |
| Repeated source changes inflate all covariance | Source priority/qualification plus an OS relative-coordinate anchor; initial OS error is retained in every observation with `2 (R_t + R_0)` and CI. No initialization-wide multiplier. | Same file: repeated provider changes, retained marginals and initial accuracy |
| No GPS aid until north alignment | Vertical velocity/altitude plus yaw-invariant horizontal velocity-change magnitude, using a stochastic velocity clone and directional-mixture covariance. | `test/ahrs-velocity-change.test.ts`: closed forms, rotation invariance, gaps, disjoint endpoints, two-minute flight, delayed replay |

The model is now `kinematic-ahrs-v5`, with 30 covariance components. The added
three are an endpoint velocity clone, not new independent sensor measurements.
Documentation and recording metadata include the new order and observation source.

The pass read PX4's actual
[magnetic controller](https://github.com/PX4/PX4-Autopilot/blob/main/src/modules/ekf2/EKF/aid_sources/magnetometer/mag_control.cpp),
[magnetic fusion](https://github.com/PX4/PX4-Autopilot/blob/main/src/modules/ekf2/EKF/aid_sources/magnetometer/mag_fusion.cpp), and
[yaw estimator](https://github.com/PX4/PX4-Autopilot/blob/main/src/modules/ekf2/EKF/yaw_estimator/EKFGSF_yaw.cpp).
The concrete lessons applied are separate startup/continuation/recovery decisions,
qualified magnetic references, heading versus full-vector observability, and an
independent yaw-acquisition path. Our existing motion fit remains distinct from
PX4's Gaussian-sum yaw estimator. The radial GPS factor is derived here, not ported
from PX4; its equations and limitations are in
[velocity-change.md](../../src/layers/ahrs/estimator/velocity-change.md).

Static review traced clone augmentation/marginalization, propagation, correction
injection, mixture covariance, frame resets, replay checkpoints, provider changes,
OS error sharing, recovery gates and recorder compatibility. Source regressions
were updated to check positive semidefiniteness where exact clones or reference
coordinates make strict positive definiteness inappropriate. This changes only
the checking tolerance, never the stored filter covariance.

The initial pass ran `npm run check` (import boundaries and TypeScript across
application/workspaces) only, respecting the user's then-current code-only
instruction. The subsequent requested deployment ran tests, as recorded below.
The [completion criteria](ahrs-rc-completion.md) still require numerical acceptance,
including drift and recovery against known truth with intermittent GPS and
realistic sensor errors.

## Deployment-test follow-up

The subsequent verification run passed its TAF proxy and static checks, then the
root suite reported **818 passed and 19 failed out of 837**. Failure stopped the
run before workspace tests and the production build. All 19 failures were in
AHRS tests.

| Cases | Finding | Action or remaining evidence |
| --- | --- | --- |
| 3 recording cases | Expected 729 covariance entries after the model grew from 27 to 30 states. | Assert `N * N` (900); exact replay checks remain. |
| 1 provider-transition case | Exact equality rejected a retained covariance difference of about `4e-19`. | Use a `1e-14` absolute roundoff tolerance; retain covariance validity and reference-error checks. |
| 2 scalar magnetic-recovery cases | An unqualified tilt prevented nonlinear recovery but still allowed the ordinary correlated-heading path to accept a correction. | Explicitly wait for qualified tilt while reacquiring. Qualified and unqualified recovery cases now pass. |
| 3 manually aligned turn cases | Peak roll error 0.555–0.576 degrees versus a 0.5-degree limit. | Retain the accuracy limit; this is measured tracking error. |
| 2 automatically aligned turn cases | Peak roll error about 2.493 degrees versus a 1-degree limit shortly after alignment. | Retain the accuracy limit; final convergence does not erase the transient error. |
| 6 steady layer cases | `tracking` status passes, but the added `tiltStd < 6` assertion fails. | The 6-degree target was added during the unexecuted refactor; the configured warning threshold is 10 degrees. Its rationale needs review. Leave the assertion unchanged rather than treating a passing status as proof of sufficient accuracy. |
| 2 OS-compass cases | Two-minute yaw error about 5.07 degrees versus a 5-degree limit. Additional diagnostics show tilt uncertainty about 11.92 degrees versus the following 10-degree assertion. | Retain both limits. This includes the user's concern about early uncertainty warnings, not just a marginal yaw miss. |

After the assertion and recovery-guard fixes, all **11 focused recording,
provider-transition and magnetic-recovery checks passed**. The broader rerun of
`ahrs-estimator`, `ahrs-layer`, `ahrs-magnetic-fusion` and `ahrs-recording` reported
**87 passed and 13 failed out of 100**. Its magnetic-disturbance fixture was
extended to assert that reacquisition waits for fresh tilt evidence and resumes
when it arrives. All six originally failing assertion/recovery cases now pass.
TypeScript/import checks and `git diff --check` also passed. No estimator tuning
or performance thresholds were changed to make the deployment pass.

The initial full run also passed the four long-duration heading-recovery
scenarios, the new yaw-invariant GPS observation cases, and the Jacobian and
covariance checks. Raw magnetometer drift correction passed the two-minute case
that failed for the OS-derived compass providers. These are useful positive
results, but do not cancel the remaining failures. The deployment remains
unpublished and numerical acceptance remains incomplete.

## Release-candidate review of v4

The follow-up [completion criteria](ahrs-rc-completion.md) define the correction
sequence, fixed acceptance conditions and evidence needed to close these findings.

**Verdict: hold the algorithm release candidate.** The estimator uses mature
estimation methods, but the current implementation still has the concrete
recovery and reference-management weaknesses below. This verdict concerns the
algorithm and its control flow. It does not depend on certification, the host
being a PWA, or substituting missing performance measurements for code review.

This pass read every TypeScript module in `estimator/`, the motion and magnetic
adapters, calibration and layer integration, and the attitude/uncertainty display
paths. It checked propagation, measurement Jacobians, quaternion injection,
covariance updates, heading acquisition, initialization, rejection, recovery,
timestamp ordering and reference changes. The examples below are deductions from
the code and equations, not executed reproductions. No tests, simulations,
numerical probes, replay, build or browser execution ran for this review. The
implementation was not changed; the findings remain open.

### 1. P1: an unqualified first magnetic sample can block healthy input indefinitely

[`fuseMagnetic`](../../src/layers/ahrs/estimator/magnetic-fusion.ts#L159) seeds
the reference and fixed normalization scale from the first sample, before the
two-second qualification window. Subsequent strength checks compare observations
with that already committed reference. Rejection retains it, and there is no
separate tentative reference that can be abandoned during initial qualification.

A static example is a first field of 75 microtesla followed by a steady field of
45 microtesla in the same direction, with steady attitude and zero innovations
from the other sensors. Both strengths pass the absolute 15–100 microtesla gate.
The reference has normalized strength 1; subsequent readings have strength 0.6.
Their 0.4 mismatch exceeds the 0.2 threshold on every retry. The holdoff and
qualification clocks cannot resolve this, because neither changes the reference.
A transient startup disturbance can therefore disable magnetic drift correction
for the rest of that session.

Qualify a tentative reference before committing it, with an explicit restart path
for inconsistent startup evidence. Preserve the existing protection against
silently replacing an established reference after later disturbances.

### 2. P1: magnetic innovation rejection can prevent entry into nonlinear recovery

The raw-vector qualification gate in
[`magnetic-fusion.ts`](../../src/layers/ahrs/estimator/magnetic-fusion.ts#L182)
runs before correction. Magnetic reacquisition is enabled by an IMU gap or by a
correction returning `attitude-limit`; a rejected innovation does neither.
A magnetic-only outage restarts qualification but does not enable reacquisition.

Consequently, after substantial yaw drift during uninterrupted IMU sampling,
returning healthy field measurements can repeatedly fail the ordinary linear
innovation gate without ever reaching the existing nonlinear solver. This is
especially significant for large rotations: for predicted field `u`, the attitude
Jacobian is `[u]x`, and `uᵀ[u]x = 0`. A large rotation can produce a substantial
radial residual that increasing yaw variance alone cannot explain through this
Jacobian. Small field/bias uncertainty then keeps that residual outside the gate.

Add an explicit, qualified recovery decision for magnetic return and persistent
reference disagreement. Evaluate the large-angle hypothesis through the nonlinear
path while retaining strength, inclination and temporal-consistency safeguards.
The decision must distinguish a candidate attitude recovery from an ordinary
field disturbance; unconditional acceptance or reference replacement is not a fix.

### 3. P2: provider changes bypass the covariance-inflation safeguards

[`seedReference`](../../src/layers/ahrs/estimator/magnetic-fusion.ts#L32)
doubles the transformed entire covariance when an OS-derived reference is
initialized. The transformation is identity on non-field state rows, so their
marginal covariance becomes exactly twice its previous value. Every source
change calls initialization again.

The adapter falls back to orientation after raw-field silence and prefers raw
fields immediately when they return. Repeated provider changes can therefore
repeatedly multiply retained uncertainty, even with steady attitude. For example,
without accepted GPS, accelerometer-bias gain rows are frozen in the aiding paths:
each new OS reference doubles that bias variance, independently of the ordinary
CI update's cost check. Ignoring other increments, its multiplier is `2^k` after
`k` such initializations.

The individual Young-inequality bound is conservative; the defect is repeatedly
paying this global initialization cost through provider selection. The v4 CI cost
guard only governs subsequent corrections. Reference management needs source
stability/hysteresis and a correlation-consistent policy for retained or replaced
references. Merely restoring selected covariance blocks after the bound would
not preserve its statistical guarantee.

### 4. P2: useful GPS evidence is unavailable until north alignment succeeds

[`observeGps`](../../src/layers/ahrs/estimator/ahrs.ts#L432) sends fixes only to
the independent heading fit while heading is acquiring or recovering. It does
not fuse even altitude or directly supplied vertical velocity into the main
filter in those modes. The fit detrends horizontal velocity and requires motion
energy, so an exactly straight, constant-velocity trajectory cannot establish
heading through that path.

Thus, a session started without manual north alignment can receive good GPS
throughout a long straight leg while the main estimator receives no GPS
corrections. This is a documented design restriction, rather than a new sign or
covariance bug, but it remains a material gap against the goal of using the
available sensors comprehensively. Altitude and vertical velocity do not require
horizontal north alignment. Steady horizontal-velocity evidence also has useful
yaw-invariant content, provided its observation and temporal-noise model are
handled correctly. Add those observations without inventing north alignment or
reusing their information independently in the heading fit.

### Core math and assessment

No additional sign/frame defect was found in the reviewed right-error quaternion
propagation, gravity and magnetic vector Jacobians, Joseph updates, tangent reset,
Schmidt restrictions, kinematic process-noise integration or yaw-frame covariance
transfers. Force enters the default main filter once as an observation. The
heading trajectory is separate, its GLS fit retains inter-time covariance, and
iterated corrections use one fixed prior with one committed covariance update.
These are substantial strengths. The use of joint magnetic states, observability
gates and separate yaw recovery is consistent with methods described in
[PX4's estimator documentation](https://docs.px4.io/main/en/advanced_config/tuning_the_ecl_ekf#magnetometer).

The core architecture does not need another wholesale rewrite on the basis of
this review. The immediate work is magnetic initialization/recovery and provider
transition handling; yaw-independent GPS aiding is the remaining coverage gap.
Unknown absolute yaw, sustained acceleration ambiguity, inability to identify
every magnetic disturbance, and optional CI updates being declined are not by
themselves implementation defects. Static inspection does not assign a numerical
degree of equivalence to a particular avionics estimator.

## Current revision: kinematic-ahrs-v4

The follow-up static review found that v3's scalar-heading path could still reject
large valid corrections indefinitely, that its CI selection ignored inflation of
calibration/acceleration uncertainty, and that gap recovery did not age retained
parameter random walks. Its exactly constant persistent acceleration also needed
an explicit allowance for later changes. These are estimator concerns, independent
of whether the host is a browser or a native application.

The v4 changes are:

- **Qualified recovery for scalar headings.** Heading-only observations now use
  the same fixed-prior iterated correction machinery as raw vectors during
  reacquisition, with a world-down yaw seed. Every weight candidate retains its
  CI correlation bound. Fresh magnetic qualification, recent accepted tilt and
  tilt uncertainty below 10° are still required. A correction that passes its
  innovation gate but exceeds the tracking range requests qualified recovery;
  this is no longer available only after a sampling gap. The normal 30° tracking
  limit remains in place, and recovery commits one observation/covariance update.
- **Account for retained-state uncertainty in CI.** Candidates must improve both
  attitude variance and a fixed scaled trace of the retained attitude, bias,
  acceleration and magnetic covariance. Each block's configured initial variance
  supplies its units. This charges for the `P[j,j] / weight` inflation of frozen
  means rather than hiding or ignoring it. With no intervening propagation,
  other updates or reinitialization, the positive cost cannot increase and bounds
  each retained marginal. Unobserved position/velocity origins do not control
  this relative-heading criterion; their full covariance update is still kept.
  Correlated input can legitimately be declined if its cost is too high.
- **Age calibration across missing time.** Gyro bias, accelerometer bias, magnetic
  field and magnetic bias receive their configured `density² × elapsed time`
  covariance increments while their nominal values are retained. Kinematic
  acceleration states age too. This remains a gap prior with an independent
  unknown-motion allowance, not reconstructed IMU propagation across the gap.
- **Allow persistent acceleration to change.** The slow component now has
  `persistentAccelerationWalk = 0.03 m/s²/√s` instead of zero process noise.
  Its mean is not pulled toward zero. The faster Gauss–Markov transient is
  unchanged. The additional noise uses the same covariance integral, including
  velocity/position cross terms. This removes the permanent-parameter assumption;
  it does not resolve acceleration/tilt ambiguity without supporting evidence.

The covariance dimension remains 27. Recordings identify the new equations as
`kinematic-ahrs-v4`; v3 recordings require the v3 estimator for exact replay.
Regression source now covers both scalar-heading providers with a missed 90° yaw,
refusal to bypass tilt qualification, one observation per iterated/CI update,
retained-state CI cost, long-gap parameter aging in both propagation modes, and
persistent-acceleration covariance growth. These cases were **not executed**.

Static review checked the unchanged quaternion convention, fixed-prior tangent
mapping, retention of CI weights during iteration, one covariance commit,
positive covariance-cost scaling, process-noise units/integration, chronological
replay of recovery flags, and recording-version compatibility. `npm run check`
passed the import-boundary and root/workspace TypeScript checks; `git diff --check`
passed. No tests, numerical probes, replay, simulations or browser execution ran.

This revision improves specific mathematical and recovery weaknesses. It is not
evidence of performance equal to an established aviation AHRS. The motion/noise
model and CI tradeoff still require numerical evaluation; correlated headings can
be declined, sustained acceleration can remain ambiguous, slowly changing magnetic
interference can imitate rotation, and broad-attitude nonlinear recovery can fail.
The next meaningful algorithm evidence would compare actual error with covariance
over steady flight, sustained maneuvers, GPS outages, field disturbances and large
missed rotations for every supported observation type.

See [gravity/acceleration](../../src/layers/ahrs/estimator/gravity-aiding.md),
[magnetic fusion and CI](../../src/layers/ahrs/estimator/magnetic-fusion.md), and
[uncertainty](../../src/layers/ahrs/estimator/uncertainty.md) for the current equations.

## Previous revision: kinematic-ahrs-v3

This revision addresses the six findings from the algorithm-only review of
`vector-ahrs-v2`. It is an implementation and static-math review, not a numerical
performance result. Tests, simulations, replay and browser execution were not run.

| Finding | Implemented change | Remaining assumption or limit |
| --- | --- | --- |
| Rejected GPS can suppress gravity | Default propagation consumes gyros; each force sample is a measurement. GPS and force observations coexist, with no receipt-based handoff. | Correct acquisition times and sensor-noise assumptions still matter. |
| Acceleration random walk and weak tilt observability | Velocity integrates persistent plus transient acceleration. A constant uncertain component preserves sustained acceleration; a separate Gauss–Markov transient decays. Ambiguous accelerometer-bias means are frozen with their covariance retained. | Sustained acceleration, bias and tilt cannot all be separated from one quiet pose. The motion model and tuning remain assumptions. |
| Raw magnetic tilt correction and calibration lack qualification | Qualifying/heading/vector/rejected modes, inclination and persistent-innovation checks, fresh qualification after rejection, and rotation-diversity gating for calibration. | Slowly changing interference can still imitate motion. Soft-iron distortion is not estimated. |
| OS orientation shares IMU errors | Correlation-bounded reference initialization and generalized covariance intersection for heading updates; unchanged prior competes with fusion candidates. | The bound requires credible marginal uncertainties and a useful local linearization. Arbitrary OS faults remain unbounded. |
| 30° gate can prevent recovery | Separate qualified nonlinear reacquisition, geometric seeds, relinearization against a fixed prior, and one covariance commit. | Recovery can reject or fail to converge; qualification cannot prove absence of acceleration/interference. |
| GPS heading uncertainty is heuristic | Generalized least squares using full inter-sample inertial covariance, nuisance velocity offset/drift, and fitted-offset/current-yaw covariance. Overlapping confirmations add no information. | GPS temporal errors beyond its configured noise model and nonlinear model errors remain. |

The default state has 27 errors: p, v, right/body attitude, accelerometer bias,
gyro bias, persistent world acceleration, world magnetic field, body magnetic
bias, and transient world acceleration. Quaternion injection, Joseph covariance
updates, and reset Jacobians remain shared. The prior becomes semidefinite when
relative yaw is defined as a coordinate gauge; no covariance floor is used to
manufacture attitude confidence.

The explicit `gravityAiding: false` option retains conventional strapdown INS.
In that mode force is a process input and is not also fused as a measurement.
The independent heading trajectory uses strapdown propagation too. This preserves
an independent source of inertial velocity for north acquisition and comparison.

Relative transitions for the heading fit come from pivoted linear solves of its
fundamental matrices. Its final covariance includes the shared current-yaw term.
The derived heading still shares errors with the separately corrected main filter;
automatic alignment therefore uses a conservative covariance bound for that
unknown cross-correlation. Manual independent heading alignment retains the
ordinary covariance transfer.

Magnetic qualification, innovation history, excitation history and reacquisition
flags are cloned in the fixed-lag replay state. Frame changes also rotate the
world-frame magnetic monitors and both acceleration components. The drift view
marks magnetic tilt aiding only in vector mode. Recording headers now identify
`kinematic-ahrs-v3` and a 27×27 covariance; earlier model recordings require their
original estimator revision.

Added regression specifications cover GPS rejection without gravity starvation,
kinematic acceleration, ambiguity-preserving bias handling, repeated correlated
headings, large missed rotations and correlated heading-fit uncertainty. Existing
specifications were adjusted for simultaneous aiding, qualification and recording
dimensions. They were written/reviewed but **not executed**.

Static verification: `npm run check` passed the import-boundary checker and root /
workspace TypeScript checks. `git diff --check` passed. The review also covered
quaternion tangent transforms, covariance-intersection bounds, kinematic process
noise, heading-fit cross-covariances, frame changes and chronological replay.
These checks establish neither runtime convergence nor a numerical drift bound.

See [acceleration/gravity math](../../src/layers/ahrs/estimator/gravity-aiding.md),
[magnetic fusion](../../src/layers/ahrs/estimator/magnetic-fusion.md), and
[heading acquisition](../../src/layers/ahrs/estimator/heading-alignment.md).
