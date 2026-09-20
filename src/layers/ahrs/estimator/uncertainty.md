# AHRS uncertainty

## Meaning and expected behavior

**AHRS uncertainty describes confidence in the complete attitude estimate: roll,
pitch, and yaw.** It summarizes the usable sensor evidence and its history,
measurement quality, sensor-bias uncertainty, correlations, reference alignment,
and remaining model ambiguity. The same principle applies to all three axes.
GPS availability, ground speed, and estimator mode are context for interpreting
evidence; none of them alone determines attitude uncertainty.

During steady, minimally accelerated operation, reliable reference observations
should maintain or improve confidence in the attitude components they constrain,
including yaw when suitable yaw evidence is available. A complementary estimator
uses gyros to follow rotation and other observations to constrain drift. With
continued effective constraints, uncertainty can settle into a bounded operating
range, with growth between corrections. It should not increase indefinitely merely
because GPS is missing, ground speed is low, or a mode is labeled unaided.

Uncertainty may still increase when an error component lacks a usable constraint,
sensor quality deteriorates, or earlier confidence proves unjustified. Persistent
growth must be explained by those missing constraints, noise, bias, or model
limitations. A mode label is not a sufficient explanation. Conversely, quiet
readings alone do not justify clamping uncertainty or resetting it to a small value.

## How the evidence complements itself

| Evidence | Contribution to attitude confidence | Remaining ambiguity |
| --- | --- | --- |
| Gyroscopes and bias calibration | Track changes in all three axes; better bias estimates reduce future drift. | Noise and uncertain or changing bias accumulate rotation error. Small measured rates alone do not prove zero rotation. |
| Accelerometers during qualified low acceleration | Supply a gravity-direction constraint, stabilizing tilt without requiring GPS. | Sustained acceleration and accelerometer bias can resemble tilt. Gravity alone supplies no yaw direction. |
| Qualified magnetic observations | Can constrain yaw changes without GPS; a trusted calibrated magnetic reference can also supply absolute direction. | Field disturbances, calibration, geometry, and correlations with OS sensor fusion affect how much information is usable. |
| GPS velocity combined with inertial motion | Helps distinguish acceleration from gravity: before north alignment, velocity-change magnitude, altitude and direct vertical velocity still aid. Informative maneuvers can establish heading. | Low speed does not invalidate gravity evidence. GPS track is not aircraft nose heading, and a turn is not automatically sufficient heading evidence. |

These are complementary sources, not an exclusive switch between “steady IMU”
and “turning GPS.” Each observation should contribute according to what it
actually measures and how trustworthy it is. The gravity/magnetic distinction is
described in [VectorNav's AHRS primer](https://www.vectornav.com/resources/inertial-navigation-primer/theory-of-operation/theory-ahrs);
the role of velocity and informative dynamics is described in its
[GNSS/INS primer](https://www.vectornav.com/resources/inertial-navigation-primer/theory-of-operation/theory-gpsins).

Steadiness is useful evidence, with an explicit allowance for ambiguity. A held
phone and straight, constant-velocity flight can both support gravity aiding.
Neither quiet IMU readings nor constant specific force prove the absence of all
acceleration. Similarly, a credible stationary constraint can inform gyro bias,
but straight flight must not silently become an exact zero-yaw-rate measurement.

## Yaw belongs in the same uncertainty model

Two different questions must remain distinguishable:

- **Relative yaw uncertainty:** how well changes in direction are known relative
  to an earlier attitude or local reference.
- **Absolute heading uncertainty:** how well that direction is aligned to north.

A stable, usable magnetic reference can help constrain relative yaw even when
its absolute compass offset is unknown. The yaw estimate need not drift freely
just because GPS is absent. However, stable relative yaw does not establish an
unknown north offset or erase uncertainty inherited from an earlier alignment.
Without a usable yaw-sensitive observation or justified motion constraint,
gyro noise and bias can still increase yaw uncertainty while gravity keeps tilt
bounded. This is a limitation of the available evidence, not an exception that
excludes yaw from the definition of AHRS uncertainty.

The estimator must retain both the confidence in attitude changes and the
knowledge of its reference. Choosing relative yaw zero defines a coordinate
frame; it is not a measurement of heading. A frame change must preserve the
uncertainty in physical quantities that remain observable.

## Current implementation and display

The ESKF propagates joint attitude, velocity, position, sensor-bias, persistent/transient acceleration and magnetic-reference covariance.
Accepted observations update that model; uncertainty is not assigned from a
GPS-present flag. Bias/attitude correlations and unresolved acceleration matter
even when the displayed attitude appears motionless.

- [Gravity/acceleration fusion](gravity-aiding.md) represents persistent unresolved
  acceleration and a separate bounded transient inside the joint covariance.
  The persistent component has a slow random walk, so a previously learned
  acceleration does not become a permanent constraint on future tilt.
  Their integral drives velocity, so GPS and accelerometer observations can
  constrain the same dynamics simultaneously. Repeated samples can learn drift
  without repeatedly resetting the acceleration hypothesis to zero.
- [Magnetic fusion](magnetic-fusion.md) directly constrains accumulated attitude
  error against a learned relative reference. Raw vectors can aid tilt as well as
  yaw; browser fallbacks have heading-only influence and use covariance intersection
  to bound unknown shared sensor errors. Acceptance must improve both attitude
  variance and a fixed cost that includes retained bias/acceleration uncertainty;
  heading improvements cannot spend that uncertainty without accounting for it.
  Redundant or overly costly readings may supply no update. Initial reference uncertainty
  and attitude/reference correlations are retained. Slow interference and unreported OS errors remain limitations. The covariance
  intersection bound is conditional on valid input uncertainty bounds and the
  local linearized model. It can increase uncertainty in unobserved components.
- [Heading acquisition and recovery](heading-alignment.md) distinguish local
  attitude from north alignment. Unknown absolute heading is reported as `Infinity`
  and as unknown in diagnostics. `relativeYawStd` exposes the local-frame yaw
  standard deviation; when aligned, that covariance also contains alignment error.

The **Tilt uncertainty** summary is the largest standard deviation of the down
direction, excluding rotation about down. Expanded diagnostics show roll, pitch,
local yaw and absolute-heading uncertainty. Tilt alone is not complete AHRS
confidence. A finite local-yaw standard deviation does not establish north, and
Euler singularities still require interpretation. Reference states and their
covariances rotate with heading-frame changes, preserving physical uncertainty.
Missing intervals also age the retained bias/reference random walks and kinematic
acceleration states, independently of the allowance for unknown attitude motion.

Displayed standard deviations are model-based **1σ estimates**, not measured
error or guaranteed bounds. Current estimates exclude fixed mounting/zero-reference
error. Any broader claim of total accuracy would need to account for that error
and other excluded effects. Source/status indicators explain recent activity;
they are not substitutes for the uncertainty estimate.

## Review requirements

- Evaluate roll, pitch, and yaw using their actual constraints, with and without
  GPS. Expect bounded uncertainty only in the components that remain constrained.
- Distinguish relative yaw stability from absolute-heading knowledge in tests
  and UI claims. Include steady magnetic evidence, its loss, and disturbances.
- Count information once: repeated or OS-fused observations must not manufacture
  confidence by hiding shared sensor data, bias, or correlated errors.
- Preserve uncertainty across frame changes and retain model ambiguity during
  repeated quiet windows. Missing evidence must neither imply perfect confidence
  nor invalidate independent evidence that is still useful.
- Check modeled uncertainty against actual error in simulation and independent
  recorded references. A smooth display or a stable uncertainty number alone
  does not establish estimator accuracy.
