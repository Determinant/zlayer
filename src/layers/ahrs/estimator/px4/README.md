# PX4 EKF2 browser port

The live AHRS executes PX4's C++ estimation core in WebAssembly. The source pin is
**v1.17.0**, commit `d6f12ad1c4f70ad3230afd7d86e971421e02fef4`, from
[PX4-Autopilot](https://github.com/PX4/PX4-Autopilot/tree/d6f12ad1c4f70ad3230afd7d86e971421e02fef4).
`upstream.json` inventories the exact translation units and hashes of every
vendored dependency. `vendor/` is unchanged upstream source with its original
copyright notices. `browser.patch` contains all local source changes. ZLayer's
host bridge and TypeScript adapter are separate from those files.

## Estimation strategy

- Upstream trapezoidal integration and coning compensation integrate every
  delivered rate sample. The upstream IMU downsampler combines increments; it
  does not select isolated samples. PX4 propagates attitude, velocity, position
  and covariance, estimates gyro/accelerometer biases, gates innovations, and
  manages aiding timeouts and resets. The output predictor supplies current-time
  attitude from the delayed EKF state.
- Gyro noise `.015 rad/s`, acceleration noise `.35 m/s²`, gyro-bias process noise
  `.001 rad/s²` and accelerometer-bias process noise `.003 m/s³` use the pinned
  flight-module defaults. These are **not** v7's noise densities. The bridge also
  sets the flight defaults for gyro-bias limits (`.15 rad/s`), GNSS velocity noise
  floor (`.3 m/s`), wind process noise (`.05 m/s²`) and magnetic strength checks.
  The C++ library initializers differ from the flight module's parameter YAML;
  intentional browser overrides are listed below. The upstream IMU control mask
  enables bias estimation and leaves optional gravity-vector fusion disabled.
  `gravityAiding: true` remains available for experiments; it is not the app default.
  Acceleration is a process input in this conventional INS model. PX4's internal
  no-aiding position/height constraints bound its unsupported navigation states;
  they are model assumptions, not external measurements or proof of rest.
- Normal calibration supplies the initial gyro bias. Subsequent bias estimation
  follows the upstream EKF, including zero-rate and zero-velocity corrections
  when automatic ground/rest qualification succeeds. Propagation retains upstream
  Earth-rate handling; the pinned zero-rate routine itself does not subtract Earth rate.
- The GNSS/IMU Gaussian-sum yaw estimator, yaw emergency reset, magnetic gating
  and magnetic-bias estimation remain upstream algorithms. A manual true heading
  seeds the current output once through PX4's quaternion-yaw reset; the same
  rotation applies to the delayed history. It is not innovation-gated or repeated.
  GNSS track is never directly declared true nose heading. The HSI's GPS-seeded display
  reference is a separate, explicitly provisional contract. Its motion comes
  from PX4's unaided yaw accumulator; the display does not integrate gyros again.

No extra low-pass is applied to final attitude. A plane can change bank or pitch
within a second. Software smoothing cannot reconstruct aliased or clipped motion,
or remove an indistinguishable vibration-induced DC offset.

## Browser capabilities and adaptations

| Input or state | Browser treatment |
| --- | --- |
| Rates and specific force | Body FRD, SI units, event acquisition-time proxy. Every delivered sample reaches the upstream integrators. No claim of hardware-rate access or pre-delivery anti-alias filtering. |
| Cadence | The downsampler has a fixed 20 ms prediction target. Accumulated increments retain their actual durations, including slower intervals and cadence changes; EKF/output-predictor timing averages use those intervals. No synthetic subdivision. |
| Delay | 300 ms configured maximum sensor delay; effective horizon depends on delivered cadence and upstream downsampling. GPS/magnetic additional delay is zero because timestamps already identify observations. Samples older than the actual fusion horizon are counted late. |
| Startup | The layer supplies the confirmed, trimmed level prior and final second of real calibration samples. The bridge fills matching IMU/output histories before delayed EKF prediction, while current output integrates each real interval. The first buffered interval is predicted only once. An instantaneous vibrating force sample cannot replace the calibrated prior; direct users without that prior still need a steady initial pose. |
| GPS velocity | Speed/track gives two horizontal components. The capability patch skips vertical fusion, gating and vertical resets when no vertical measurement exists. No zero vertical speed is invented. |
| GPS position/height | Coordinates and reported altitude/accuracy are forwarded. Missing coordinates and height are masked separately. Browser altitude retains its provider datum; no barometric or MSL measurement is invented. |
| Accuracy | Browser position/altitude 95% half-widths are divided by 1.96. Unreported velocity accuracy uses an explicit 1.5 m/s assumed standard deviation. Supplied axis standard deviations are conservatively reduced to their maximum for PX4's scalar receiver interface. |
| Receiver metadata | Fix type, satellites, DOP, spoofing and speed-accuracy checks unavailable to the browser are disabled; horizontal position accuracy and explicit browser quality/source invalidations are checked. Default ten-second initial GNSS health qualification remains. Gaps over twice the 1.5 s maximum interval restart the health timer; after initial qualification PX4's shorter recovery interval applies. |
| Airspeed, barometer, range, optical flow, external vision | Disabled. Groundspeed never substitutes for true airspeed. Wind/terrain slots remain in the committed 24-state generated layout, but unavailable sensor fusion is not enabled. |
| Magnetics | Only platform-calibrated XYZ readings enter PX4, converted from µT to gauss. Magnetic strength checking is enabled. OS-fused orientation and WebKit compass permissions/listeners are not requested; historical recordings retain their source labels. |
| Landed/rest state | Automatically qualified from fresh reported GPS speed and IMU evidence, with separate landed and rest flags. Unknown state supplies `in_air=true, at_rest=false`. These are host operating assumptions, not independent flight-status measurements. |
| Clipping/temperature/range | Browser events expose none of PX4's hardware clipping, calibration or temperature metadata. No measured clipping counters or hardware vibration-quality claims are fabricated. |

### Automatic ground qualification

`ground-state.ts` owns a conservative browser adaptation of PX4's separate landed
and rest decisions. No pilot mode switch is required. A candidate stop needs
reported GPS speed at most 0.5 m/s, accuracy at most 10 m and fixes no older than
2.5 s. A time-aware two-second speed low-pass also must settle below 0.5 m/s.
Five seconds of this evidence, with mean specific-force magnitude within 0.15 g
of gravity and reported vertical speed below 1 m/s when available, qualifies landed.

Rest additionally requires one second with bias-corrected gyro magnitude at most
3°/s, half-second mean rate at most 0.5°/s, and gyro/acceleration sample-difference
metrics below 0.02 rad/s and 1.2 m/s². Those vibration limits and the 3°/s veto
come from the pinned land detector. The time-aware half-second smoothing is a
browser assumption, not an equivalent measurement chain: PX4 computes vibration
from integrated IMU increments (200 Hz default), smoothing each difference with
weight 0.01. Its 3°/s veto uses a separate filtered angular-velocity output with
a default 40 Hz second-order low-pass. Our veto uses each delivered browser rate.
Neither that cutoff nor the vibration thresholds are validated for browser
cadence. The output filter does not filter PX4's EKF inputs; see the pinned
[IMU publisher](https://github.com/PX4/PX4-Autopilot/blob/d6f12ad1c4f70ad3230afd7d86e971421e02fef4/src/modules/sensors/vehicle_imu/VehicleIMU.cpp)
and [gyro filter parameters](https://github.com/PX4/PX4-Autopilot/blob/d6f12ad1c4f70ad3230afd7d86e971421e02fef4/src/modules/sensors/vehicle_angular_velocity/imu_gyro_parameters.c).
Raw speed above 1 m/s or failed IMU checks releases rest. A landed aircraft can taxi without
being at rest; raw speed above 3.5 m/s releases landed, matching PX4's reduced
5 m/s limit without airspeed. Missing/poor/stale GPS, vertical/force inconsistency
or an IMU gap clears qualification. GPS fixes are queued until their timestamps
apply to the IMU stream; newer fixes do not interrupt qualification of older IMU
samples while the preceding fix remains fresh. Rejected fixes and movement clear
the relevant qualification at their timestamps, even when several fixes precede
one IMU callback. The queue holds at most 32 fixes; overflow clears old evidence
and qualification.

The layer forwards new fixes even when their speed or quality is unusable, so
rejection can clear previous evidence. Source failures without a new fix enter
as timestamped invalidations. They clear ground qualification and fail native
GNSS health checks at the appropriate horizon; no position or velocity is fused.

Both flags enter PX4 through timestamped `setSystemFlagData`, so transitions apply
at the delayed IMU horizon. Ground qualification is deterministic from recorded
inputs and resets with the estimator. `Attitude.groundState` reports the delayed
assessment; `unknown` includes flight. The UI exposes no extra controls.

`Attitude.groundDiagnostics` captures the host's latest IMU-time qualification
reason, reported and smoothed speed, GPS age, absolute vertical speed when
available, mean-force deviation from gravity, instantaneous and mean corrected
angular-rate magnitudes, both vibration metrics and the stop/rest timers. Values
use SI units. These precede the delayed `groundState`; a qualified host decision
can still be pending in PX4. Before the first IMU sample diagnostics are absent;
when motion stops, the last diagnostic timestamp and values remain historical.
The existing diagnostics disclosure shows the reason, rate and vibration values
only while motion is live. Debug-log state snapshots include all fields. The
vibration metrics are sample-difference norms, not RMS noise estimates; do not
copy them directly into `gyroNoise` or `accelNoise`.

This is not PX4's complete land detector: browser inputs lack arming state,
airspeed, reliable vertical velocity on most devices, and hardware vibration
metrics. Low groundspeed in strong wind can be ambiguous. Strong engine vibration
can veto rest rather than enable bias learning. These thresholds and the DA40
installation remain unvalidated; smoothing GPS alone does not prove rest.

The recording model is `px4-ekf2-v1.17.0-browser-v4`. Browser v2 introduced flight
defaults and automatic ground qualification; v3 corrected cadence, buffer startup,
heading validity and GPS/IMU ordering. V4 adds explicit GPS invalidation and
health continuity, verified GNSS handoff after magnetic startup, and removes
synthetic heading observations after alignment. Earlier browser versions require
their original revision because these changes affect estimator behavior.

The patch adds per-fix horizontal/vertical velocity, position and height validity;
skips unavailable velocity axes in fusion/reset/aiding status; permits the browser
GNSS cadence; and preserves actual IMU durations and timing averages instead of
clamping them to hardware-rate assumptions. Friend access lets the bridge seed
calibrated priors and output-predictor biases, prime matching delayed histories,
and expose diagnostics. The patch also frees the system-flag buffer omitted by
the pinned upstream destructor. The zero-innovation heading constraint now runs
only while yaw is unaligned: a relative yaw gauge can be bounded, but aligned
heading uncertainty must grow without aiding. The Kalman prediction and
measurement equations are unchanged. No newer `main` behavior is silently mixed
into this release pin.

## Recovery, ownership and diagnostics

A gap over 250 ms is not integrated. The app's recovery option creates a new EKF,
retains pose and both bias means, and increases the tilt prior by an engineering
allowance for unobserved motion. Navigation, magnetic state, cross-covariances and
absolute heading qualification restart. A new genuine input primes the integrator;
subsequent real intervals refill both delayed histories before EKF prediction
resumes. The output predictor continues throughout that warmup. No
acceleration-derived relevel is substituted for retained pose. Standalone
instances instead latch interruption unless recovery is explicitly enabled.
An explicit estimator reset retains a learned gyro bias with its current
uncertainty; before initialization it retains the supplied calibration prior.

One embedded WASM module owns independent filter allocations. `snapshot.json`
defines the C++/TypeScript diagnostic layout; the build generates its C++ constants.
Only consumed fields cross the boundary. Layer replacement
and disposal release them; `FinalizationRegistry` is a fallback for abandoned
standalone instances. Nothing schedules background work inside the module.

The covariance is 24×24, in upstream tangent-state order: NED attitude error,
velocity, position, gyro bias, acceleration bias, earth magnetic field, body
magnetic bias, horizontal wind and terrain. Quaternion output is `[w,x,y,z]`.
Display tilt uncertainty is the largest horizontal attitude-covariance eigenvalue's
square root. Euler uncertainties use the appropriate local projection and mark
near-vertical yaw/roll as unbounded. Heading tracking also requires PX4's current
`yaw_align` flag and a current manual/GNSS alignment tracked by the bridge.
Losing alignment or a quaternion reset without a new GNSS yaw alignment revokes
that source. A magnetic re-alignment cannot restore an old manual/GNSS label's
validity. If magnetics initialized yaw first, the bridge can perform PX4's GNSS
yaw reset once accepted recent velocity aiding, upstream GSF convergence and
the upstream 25° disagreement gate all pass. This seeds both yaw and its
covariance without treating magnetic alignment alone as verified north.
`headingReference` retains history only. These are model estimates, not
calibrated integrity bounds.

PX4 aid-source reports expose sequential per-axis innovation variances. Recorded
diagnostics identify `covarianceKind: sequential-diagonal` and
`gateKind: per-axis-sigma`. Their summed normalized residual is descriptive; it
is not v7's joint chi-square gate. Gravity residuals use a unit gravity vector,
magnetic residuals use gauss, velocity uses m/s, and height uses metres. Counts
cover reported sensor aid sources, not zero-rate/zero-velocity or internal
fake-position/height constraints.
Aiding status reflects accepted observations;
PX4's heading-only and full-vector magnetic modes are reported separately.

## Build and verification

Ordinary app builds use the checked-in embedded module; they do not download PX4
or require a C++ compiler. `npm run ahrs:check` verifies source and build hashes.
To rebuild, install **Emscripten 5.0.6**, then run from the repository root:

```sh
npm run ahrs:build
npm run ahrs:check
node --import=tsx --test test/ahrs-px4.test.ts
python3 tools/ahrs-px4-parity.py
```

The build generates only the three required uORB data structs from pinned message
schemas. It does not import the autopilot runtime. The native parity probe uses
clang++ and compares state and full covariance with WASM through calibrated
startup, vibration, heading reset and partial GNSS aiding. Execution agreement is not an
independent truth reference. See [validation](../../validation.md) for the required
app checks and remaining DA40/device evidence.

PX4's BSD-3-Clause [license](vendor/LICENSE) and per-file notices are retained.
The binary redistribution notice ships at `/licenses/px4.txt`. Both the live app
and [offline replay](../../recording.md#offline-estimator-replay) use this PX4 model.
Older recordings require their original estimator revision.
