# AHRS algorithm completion criteria

This is the bounded follow-up to the
[v4 algorithm review](ahrs-algorithm-2026-09-19.md#release-candidate-review-of-v4).
It defines the work and evidence required before the next release-candidate
assessment. The v5 implementation pass recorded code changes separately from
numerical acceptance. Its deployment failures led to the bounded v6 correction
and passing numerical verification recorded below.

## Scope and sequence

Retain the current quaternion error-state estimator and shared propagation,
measurement and covariance machinery. Resolve the identified initialization,
recovery and provider-transition problems in a focused correction pass. A change
to the core equations needs a specific demonstrated defect or observation-model
requirement, with its covariance consequences reviewed before implementation.

1. Resolve magnetic startup and recovery together, using explicit reference/trust
   transitions. A provisional reference is distinct from an established one.
2. Resolve provider transitions using the same reference lifecycle. Review the
   unknown-correlation bound through initialization as well as ordinary updates.
3. Specify GPS observations that remain usable before north alignment, including
   their noise and information-sharing assumptions, before adding their fusion.
4. Review the complete resulting estimator against the criteria below. Record
   numerical verification separately from static inspection.

## Findings to close

| Finding | Required behavior | Closure evidence |
| --- | --- | --- |
| Magnetic startup reference: correctness defect | A temporary first-sample disturbance cannot permanently prevent qualification of later healthy evidence. An established reference remains protected against replacement by later disturbances. | Trace provisional/qualified/rejected transitions; cover bad first strength and direction, interrupted qualification, and a disturbed established reference. |
| Magnetic return after yaw drift: correctness defect | Healthy returning evidence has a reachable, qualified nonlinear recovery path when ordinary linearization fails. An innovation rejection alone does not establish that the field is trustworthy. | Trace return with continuous IMU sampling and large yaw error; cover valid recovery, disturbed fields, inadequate tilt evidence, and failed nonlinear convergence. |
| Provider switching: robustness issue | Switching providers cannot repeatedly impose an unchecked global covariance multiplier. Accepted reference changes preserve a valid joint uncertainty treatment and do not snap attitude. | Trace repeated raw/OS transitions, stale callbacks and rejected candidates; account for all covariance blocks and retained reference correlations. |
| GPS before north alignment: capability gap | Use available yaw-independent information without assigning an unsupported north heading or counting shared evidence twice. | Specify and review altitude and direct vertical-velocity fusion; separately derive the intended horizontal steady-velocity constraint and its temporal noise/correlation model. |

The GPS item is an explicit required capability extension under the user's
continuous-self-correction guideline. Full horizontal velocity cannot simply be
injected in an arbitrary yaw frame. v5 uses a yaw-invariant radial likelihood with
stochastic endpoint cloning; the [derivation](../../src/layers/ahrs/estimator/velocity-change.md)
records the noise, pairing, mixture covariance and heading-sharing assumptions.
No-GPS gravity and qualified magnetic correction remain active; intermittent GPS
adds constraints without a north-alignment prerequisite.

## Estimator invariants

- One documented body/world/quaternion convention applies to every sensor,
  measurement Jacobian, propagation step and covariance reset.
- Each observation contributes information once. Shared IMU, OS-heading and
  heading-fit errors are represented or conservatively bounded.
- Covariance remains finite, symmetric and positive semidefinite, including
  Schmidt updates, source changes, reference changes and nonlinear recovery.
  Numerical checking does not manufacture confidence by clamping covariance.
- Iterated recovery uses one fixed prior and commits one state/covariance update.
  Failed candidates leave the live attitude and calibration means unchanged.
- Unknown north alignment remains unknown. Relative magnetic observations cannot
  create an absolute north reference.
- Rejected measurements do not claim active aiding. Loss of one optional aid does
  not suppress valid observations from another.
- Bias and magnetic calibration are updated only with the required observable
  information; frozen means retain their uncertainty and cross-covariance.
- Missing intervals are handled as missing information. Parameter uncertainty is
  aged and recovery eligibility is explicit.
- Delayed-event replay reproduces the chronological estimator update within its
  retained history. Reference/trust decisions that affect those updates belong
  to replayed state, or have an explicitly documented boundary.
- Diagnostic uncertainty, source activity and heading status describe the actual
  estimator state. They are not substitutes for comparing attitude with truth.

## Evidence and stopping rule

The correction pass is complete when each in-scope finding has a documented
resolution, its before/after transition or equation is reviewable, and the full
result has been checked against the same invariants. Additional findings must
identify a specific violation and supporting evidence. Preferences and optional
enhancements are recorded separately; they do not silently change the criteria.
An actual new correctness defect remains a blocker even after earlier checks pass.

Use three distinct claims in the final assessment:

1. **Implemented:** the intended paths and equations exist.
2. **Statically reviewed:** code, math and mode transitions have been inspected.
3. **Numerically verified:** the stated cases have actually been executed and
   their results recorded.

For an algorithm RC, numerical evidence should cover the changed reference and
recovery paths plus the existing steady-flight, maneuver, GPS-loss, magnetic-loss,
disturbance, delayed-delivery and gap scenarios. Evaluate attitude error against
known truth, estimated uncertainty, aiding acceptance and recovery behavior.
Jacobian/covariance checks and scenario regressions answer different questions;
both matter. Long steady segments should include the 1–2 minute concern raised
by the user and longer behavior, with and without GPS and magnetic aiding.

Specify scenario assumptions, pass limits and their rationale before observing
results. Do not choose limits merely to make a run pass. Report drift/error and
uncertainty together, and keep physical unobservability distinct from a defect.

The initial implementation review covered source code only. Subsequent
verification included tests. The resulting numerical evidence is recorded
below and in the [test triage](ahrs-algorithm-2026-09-19.md#deployment-test-follow-up).
No percentage of equivalence to an unspecified avionics algorithm is part of
these acceptance criteria.

## Current status

- **Implemented:** all four reference/recovery/GPS findings have code paths and
  documented equations/transitions. Subsequent numerical failures led to the
  recovery guard, rotation-dependent acceleration noise and turn-preserving
  heading refresh described in the [v6 review](ahrs-algorithm-2026-09-19.md#v6-beta-verification).
- **Statically reviewed:** shared sensor use, complete covariance updates,
  auxiliary rate history, gap aging, frame resets, recovery qualification,
  trajectory age limits and recording compatibility were checked.
- **Numerically verified:** `npm run verify` passes all **961 unit tests**, import
  boundaries, TypeScript and the production build. The original turn, compass
  drift and six layer uncertainty limits remain unchanged. Added regressions
  cover vibration, gap handling, trajectory refresh and older-recording refusal.
- **Browser verified:** 306 Chromium cases pass, including the corrected
  visibility/recovery case on a focused rerun. The graphics matrix passes
  32 Firefox and 64 WebKit/2× WebKit cases, with three intentional platform skips.
- `npm audit --omit=dev` reports zero vulnerabilities. Hosting requirements and
  remaining release checks are listed in [deployment readiness](../deployment-readiness.md).
- The earlier 19-failure deployment and subsequent 13-failure triage are retained
  as historical evidence in the review; they no longer describe the current tree.
