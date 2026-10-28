# AHRS validation

[Documentation](../../../docs/README.md) / Plugins / [ahrs](README.md)

The live estimator is [pinned PX4 EKF2](estimator/px4/README.md). Browser
integration, native/WASM execution agreement, synthetic accuracy, and physical
installation performance are separate checks. Passing one does not establish the
others. The tool remains experimental and has not been flight validated.

## Estimator invariants

- Preserve body FRD, NED and quaternion conventions, actual sample intervals and
  every delivered IMU sample, including while stowed.
- Keep vendored upstream files unchanged; represent adaptations in the reviewed
  patch and bridge. Generated binary and input hashes must agree.
- Missing GPS axes, receiver metadata, airspeed and hardware clipping information
  must remain missing. OS-fused compass data cannot impersonate a raw magnetometer.
- Qualify landed and rest separately from fresh GPS and IMU evidence. Unknown
  state disables ground constraints; zero GPS speed alone must not suppress
  rotation or require a user mode change.
- Report finite state, covariance, actual fusion results and unknown heading
  honestly. PX4's per-axis residual diagnostics are not a joint chi-square test.
- Never extrapolate missing IMU data. Preserve pose with larger uncertainty on
  app recovery and rebuild navigation/heading evidence.
- Match native C++ and WASM behavior for the same source, configuration and inputs.
  Agreement does not substitute for independent attitude truth.

## Input and recovery requirements

The current [port guide](estimator/px4/README.md) specifies sensors, units, cadence,
delayed horizon, partial GNSS patch, automatic ground qualification and gap recovery.
Calibration primes the core with real recent IMU history; recording/replay must
preserve that history. Browser event creation
is only a proxy for hardware acquisition. No test can infer unreported hardware
clipping or remove aliasing that occurred before delivery.

## Regression coverage

- `test/ahrs-px4.test.ts`: calibrated vibration at 20/30/60/120 Hz,
  covariance health, mounted vibration without north alignment, rotation at zero
  GPS speed, native instance disposal, calibrated bias startup,
  gaps, missing vertical velocity, GPS health qualification, raw versus OS-fused
  magnetics, a coordinated turn and one-second roll response.
- `tools/ahrs-px4-parity.py`: native clang versus generated WASM during vibration,
  a calibrated prior, heading reset and GNSS with a missing vertical velocity.
  It checks attitude, biases, velocity and every entry of the 24×24 covariance
  with an acceptance limit of 2×10⁻⁵. This is execution agreement only.
- Calibration, layer, clock, HSI, display, sensor ownership and recording tests
  continue to exercise the live core. Layer GPS fixtures now integrate coordinates
  consistently with their speed/track; a fixed position plus sustained 55 m/s
  is not a physically consistent navigation input.
- `test/e2e/ahrs.spec.ts` exercises the built app with actual browser motion events,
  calibration, vibration, sensor pauses, GPS loss, uncertainty, recovery and
  visibility transitions. Recording, full-screen and instrument browser suites
  cover the corresponding presentation and persistence contracts.

Synthetic vibration tests require peak roll/pitch below 3° after normal
calibration for their specified bounded, below-Nyquist signals. They are chosen stress
limits, not measured DA40 limits. A raw-magnetic heading integration test now
uses PX4's measured behavior (under 2° lag in that fixture). The previous v7
under-1° bound belongs to its historical model and is not a PX4 result.

The mounted-vibration replay also keeps its original under-3° roll/pitch limit
after calibration. During the initial PX4 port, enabling optional gravity-vector
fusion caused a pitch error above 6° in the replay without north alignment;
leaving that path disabled passed the same limit. This is historical evidence
for retaining the upstream default, not validation of subsequent changes.
Internal no-aiding position/height
constraints can still stabilize the filter. The UI does not label those model
constraints as measured GPS or gravity aiding.

## Remaining validation work

The browser v2 flight-default corrections, automatic ground qualification and
raw-only magnetic sensing, v3 timing/startup corrections, and v4 heading and GPS
health corrections still need full regression and DA40 validation. Earlier
results do not establish their performance. Compilation alone does not validate
these changes.

A limited replay of the 16.3-second legacy recording ending `95ff9562.jsonl`
through browser v4 produced finite states and covariance, but did not reduce its
broad roll excursions. It used the header pose and gyro-bias prior with current
PX4 defaults, without copying the incompatible old covariance or inventing
startup history. Original GPS forwarding, current forwarding with original
timestamps, and an inferred constant GPS clock correction were compared.
Even with that correction, the filter qualified landed but never rest, and
accepted no GPS velocity or gravity updates. This is evidence about response
to those inputs, not measured attitude accuracy: the capture lacks calibration
history and independent sensor-orientation truth. Detailed replay inputs,
assumptions and results belong with the local evidence under `tmp/`.

1. Record the DA40 installation from before engine start and calibration through
   stationary engine-running vibration, with independent attitude truth. Compare
   actual acquisition cadence, raw means, spectrum,
   temperature and mounting. Determine whether the real failure is bias,
   vibration rectification, clipping, aliasing, mount motion or a combination.
   Use `groundDiagnostics` to identify rest vetoes, observe both qualification
   timers, and compare with delayed `groundState` and gyro-bias estimates. A rate
   or vibration limit exceeded only between the 10 Hz state snapshots can still
   restart qualification; inspect the recorded full-rate IMU inputs as well.
   The copied land-detector thresholds do not establish equivalence with PX4's
   integrated IMU metrics or its separate filtered angular-velocity output.
   Select any cutoff and noise/bias changes from the delivered device data,
   including sustained real rotation, rather than from sample-difference metrics
   alone. The diagnostic additions do not change estimator parameters or validate
   the DA40 installation.
2. Check statistical consistency and real error across cruise, shallow and strong
   turns, sustained acceleration, crosswind, GPS correlation, bias changes,
   thermal drift and long outages. In particular, PX4's GNSS yaw GSF without
   airspeed is not equivalent to a fully instrumented flight controller.
3. Exercise ground qualification through stops, taxiing, takeoff, zero-speed
   rotation, vibration, strong-wind ambiguity, GPS loss/poor accuracy and IMU gaps.
   Check entry/release timing at different delivered cadences and GPS/IMU callback
   orders, delayed system flags, replay determinism and buffer disposal. Check
   alternating/jittered intervals and the first delayed prediction after startup
   or recovery: accumulated durations must remain intact, and no interval may be
   predicted twice. Rest must release on movement; excessive vibration can
   legitimately prevent rest qualification. Magnetic re-alignment must not
   revive stale manual/GNSS heading validity, and heading resets must not create
   spurious HSI gyro motion.
   Verify GNSS acquisition after magnetic startup, uncertainty growth after
   manual/GNSS alignment without aiding, and timestamped GPS failures through
   the live layer and recording/replay. Missing updates must not count as a
   continuous healthy GNSS qualification interval.
4. Verify native device permission with raw-only magnetics, sensor conventions,
   suspension, foreground recovery, offline launch, memory and scrolling on
   supported phones/tablets.
   Browser simulation cannot qualify hardware anti-alias filtering or vibration
   tolerance. Follow [deployment readiness](../../../docs/development/deployment.md#verification-and-remaining-release-gates)
   and [AHRS memory checks](../../../docs/verification/memory-resources.md#ahrs-session-memory-and-scrolling).

## v6 beta verification

The original results, numerical limits and unresolved consistency findings remain
in [historical v6 verification](https://github.com/Determinant/zlayer/blob/52507ff98ef50d7a3b08a87e98cf9ab13154e845/src/layers/ahrs/validation.md#v6-beta-verification).
They do not validate the live PX4 core.

## v7 vibration and HSI regressions

The September 25, 2026 results and original stress definitions remain in
[historical v7 evidence](https://github.com/Determinant/zlayer/blob/52507ff98ef50d7a3b08a87e98cf9ab13154e845/src/layers/ahrs/validation.md#v7-vibration-and-hsi-regressions).
The v7 engine and its numerical tests remain in that revision. Replay of those
recordings requires the original estimator; the current tree contains only PX4.

## Reproduce and extend the evidence

Run from the repository root:

```sh
npm run ahrs:check
node --import=tsx --import=./test/helpers/assets.ts --test test/ahrs-*.test.ts
python3 tools/ahrs-px4-parity.py
npm run verify:standard
npm run test:browser -- test/e2e/ahrs.spec.ts test/e2e/ahrs-recording.spec.ts
```

The standard gate includes Node tests, builds and browser smoke checks. Sensor
fusion changes additionally require the complete AHRS browser suite. Full
cross-engine/graphics and device release checks remain separate. Record actual
run outcomes; a checked-in test or historical result is not proof of a current pass.

See the [recording contract](recording.md) for receipt-order replay, matching
model identifiers and complete calibration initialization.

## Method references

The [PX4 source pin and patch](estimator/px4/README.md) are the implementation
reference. [PX4's EKF tuning guide](https://docs.px4.io/main/en/advanced_config/tuning_the_ecl_ekf)
explains the general strategy. Earlier research references and their limits remain
in the [historical methodology](https://github.com/Determinant/zlayer/blob/52507ff98ef50d7a3b08a87e98cf9ab13154e845/src/layers/ahrs/validation.md#method-references).
