# AHRS magnetic drift aiding review — 2026-09-19

Historical review of the earlier bias-only implementation. Superseded by the
[vector-fusion refactor](../../src/layers/ahrs/estimator/magnetic-fusion.md), whose
new regressions have not been run. Results below do not validate that refactor.

This review covers the optional magnetic input, its estimator update, lifecycle,
diagnostics and recording/replay in the cross-platform PWA. The then-current design
was [relative magnetic drift aiding](../../src/layers/ahrs/estimator/magnetic-drift.md).

## Resulting behavior

Available calibrated field vectors or browser compass/orientation readings are
compared with a private gyro trajectory over disjoint 20-second windows. Qualified
changes slowly adjust gyro bias along current down, reducing future yaw drift.
They do not establish north, remove accumulated heading error, or directly correct
pitch/roll. Independent GPS/IMU and manual heading alignment keep their existing
roles. Optional magnetic failure leaves motion and GPS available.

There is no new figure-eight step. The app uses platform magnetic calibration or
fusion and checks the resulting changes; it does not estimate hard/soft-iron
parameters. Relative differences remove a constant angular offset, but cannot
generally remove distortion that changes with orientation. The design's
[calibration policy](../../src/layers/ahrs/estimator/magnetic-fusion.md#calibration-and-the-figure-eight-question)
explains this distinction and the comparison with drone calibration.

## Defects found and corrected

| Finding | Correction and regression evidence |
| --- | --- |
| Magnetic azimuth was treated as a pure yaw-bias observation. In an inclined field, horizontal gyro errors also change azimuth. | Propagate the complete three-axis rate sensitivity through every IMU interval. Include all gyro-bias covariances in the innovation. Independent central finite differences verify all three sources at multiple poses with compound rotations; a separate test checks that horizontal bias uncertainty weakens yaw learning. |
| The permitted correction direction came from the beginning of the evidence window. Independent tilt corrections could make it stale. | Restrict the applied gain to current body down. A regression checks that the correction has no horizontal component in the current world frame. |
| A source switch immediately after a completed window could retain an obsolete active indication. | Clear qualification on every admitted source change and require a complete new window. A regression switches sources at that boundary. |
| A failed raw sensor retained its listeners and temporarily suppressed browser-compass fallback. | Detach and stop the failed sensor, clear its freshness, and allow immediate fallback. The adapter test also rejects later events from the failed instance. |
| Large vertical GPS velocity uncertainty relaxed a horizontal-motion gate. | Use only horizontal velocity uncertainty. A regression confirms that poor vertical accuracy cannot excuse horizontal acceleration. |

The update retains bounded corrections, a bias-uncertainty floor, field and timing gates,
and fresh evidence after rejection. Its scalar measurement can couple the three
gyro biases; its applied correction remains restricted to yaw drift. A full 3D
magnetic tilt update would require a separate model, including the dependence of
browser-fused orientation on existing inertial sensors.

## Verification and reproducibility

Implementation verification completed before this documentation follow-up:

- `npm run verify` passed: 840 tests (729 root, 14 contracts, 97 domain), import
  boundaries, TypeScript checks and the production build.
- The magnetic drift/interference browser scenario passed in Chromium, WebKit
  and Firefox, using synthetic sensor events and the Playwright container.
- Recording/replay reproduced attitude and covariance exactly through mounting
  trim, stowing and sensor loss. It also preserved magnetic diagnostic reasons.
- Whitespace checks passed.

Focused numerical, adapter and replay tests can be rerun from the repository root:

```sh
node --import=tsx --test test/ahrs-magnetic-drift.test.ts test/ahrs-magnetic-sensor.test.ts test/ahrs-recording.test.ts
```

The browser scenario is `magnetic drift aiding uses absolute orientation and
suspends on a field jump` in `test/e2e/ahrs.spec.ts`. The repository's default
browser configuration runs Chromium:

```sh
npm run test:browser -- test/e2e/ahrs.spec.ts --grep 'magnetic drift aiding'
```

The three-engine review used a temporary Playwright configuration selecting that
same test with Chromium, WebKit and Firefox projects. These checks establish the
tested software behavior; they do not establish phone sensor accuracy, the
installation's magnetic integrity, or statistical coverage in flight. Slowly
varying interference and hidden OS filtering can still resemble gyro drift.
Comparison of physical recordings with an independent reference remains open.
