# Qualified relative magnetic fusion

The estimator retains a world magnetic reference and body magnetic bias in the
joint 30-state covariance. Raw fields use all three axes when qualified. Browser
orientation/compass observations use heading only. No source assigns absolute
north or substitutes GPS ground track for aircraft heading.

## Raw field model and initialization

Raw fields are divided by the initial field magnitude, retained as a fixed scale.
Later samples are not independently normalized, so strength changes remain visible.

```
u = Rᵀ m_world
z_mag = u + b_mag + noise
H_theta = [u]×, H_m = Rᵀ, H_b_mag = I
```

A provisional datum must remain consistent for at least two seconds and four
samples before the current raw reading seeds `m_world = R(z - b_mag)` without
correcting attitude. The provisional window changes no live means or covariance;
it is qualification, not an average of independent observations. A source change,
a gap over one second, strength change over 15%, or world-direction change over
15° restarts it (Safari allows three times its reported heading accuracy).
Thus a disturbed first reading can be discarded without poisoning the reference.
Its Jacobian has `J_theta = -R[z-b_mag]×` and `J_b_mag = -R`. Transforming the
complete joint covariance with that Jacobian preserves shared attitude/reference
uncertainty. Initial body-bias standard deviation is 0.1 of the field norm; raw
measurement standard deviation is 0.035 per axis. Reference and magnetic-bias
random walks remain 0.0002 and 0.0005 normalized units/√s.

## Trust and calibration

The replayed magnetic state has four modes: qualifying, heading, vector and
rejected. Valid observations must remain consistent for two seconds before fusion.
An interruption longer than one second restarts qualification. Rejection starts a
two-second holdoff, followed by fresh qualification; the old reference is retained.

Raw strength must be 15–100 µT and remain within 0.2 normalized units of its
predicted strength. Inclination is checked against the tilt estimate, allowing
its uncertainty. A five-second exponentially weighted world-frame innovation
monitor detects persistent disagreement and excess innovation energy. It uses
predicted innovation covariance, including attitude/reference uncertainty: mean
residual is normalized by vector RMS error, and energy by the three observation
dimensions. Thresholds are 1.5 and 3 respectively after five seconds of healthy
evidence. Instantaneous chi-square gating also applies during qualification.
These monitors are suspended during explicit attitude reacquisition,
when a large attitude error is already expected.

Full-vector fusion requires a recent accepted accelerometer observation and tilt
standard deviation below 10°. Otherwise the raw vector has heading-only influence.
The heading gain projects attitude and gyro-bias correction onto current down;
other means remain unchanged, with a complete Joseph covariance update.

Calibration uses a ten-second exponentially weighted rotation matrix. The
excitation criterion is positive definiteness of `0.98 I - mean(R) mean(R)ᵀ`,
after at least three seconds. This requires rotation diversity beyond a single
axis. Without this qualification, magnetic-bias gain rows are frozen. Learning
the world reference additionally requires recent accepted GPS velocity. Frozen
means remain uncertain, with all correlations retained; they are not perfect
known constants. Accelerometer-bias learning also requires recent GPS.

A near-vertical raw field can aid tilt in vector mode but provides weak yaw
information. Geometry remains in the observation Jacobian. Slow magnetic changes
that imitate real rotation can remain indistinguishable; strength, inclination
and innovation monitoring cannot detect every such change. Hard-iron estimation
does not model soft-iron distortion, scale error or saturation.

## Correlated heading observations

Absolute browser orientation supplies a reconstructed north vector. Safari supplies
heading, accuracy and its body reference axis. The scalar residual remains
`azimuth(R axis) - browserHeading - azimuth(reference)`, wrapped to ±π. Minimum
noise is 5°, enlarged for a weak horizontal OS-vector projection; invalid compass
accuracy or near-vertical axes are rejected. Maximum admission rate is 2 Hz.

OS sensor fusion can share our IMU's errors. Define its relative anchor from the
reported initial datum, rather than treating it as a noisy measurement of a
physical world field. For a scalar compass `b_0`, the anchor is
`a = azimuth(R_true_0 axis) - b_0`. Its initialization error is just the initial
attitude error; the Jacobian transform preserves the existing retained marginal
without a global covariance multiplier. The vector fallback uses the analogous
`m = R_true_0 reportedVector_0` construction. These OS references are virtual
relative coordinates, not independently known magnetic fields.

Initial sensor error remains in every later residual as `e_t - e_0`. Retain its
initial angular variance `R_0` and use the bound `R_relative = 2 (R_t + R_0)`.
This bounds unknown correlation between the two errors. Generalized covariance
intersection additionally bounds their correlation with the current state and
previous uses of that initial datum:

```
P_scaled = P / weight
R_scaled = R / (1 - weight)
P_new = (I-KH) P_scaled (I-KH)ᵀ + K R_scaled Kᵀ
```

Before trying CI weights, scalar innovations use the correlation-independent
variance bound `(sqrt(H P Hᵀ) + sqrt(R_relative))²` and the usual one-dimensional
0.999 chi-square gate. This follows Cauchy–Schwarz for the unknown cross term.
The posterior CI inflation therefore cannot make an abrupt field jump appear
acceptable merely by choosing a small measurement weight. Qualified recovery
still uses the actual attitude prior; broad drift uncertainty can admit a large
correction that a tight prior rejects.

The heading-restricted gain still uses the full covariance. Candidate weights
0.995, 0.99, 0.98, 0.95, 0.9, 0.8, 0.65 and 0.5 compete with the unchanged prior.
An update must reduce both total attitude variance and a fixed, dimensionless
trace cost over all retained attitude, bias, acceleration and magnetic states.
Each three-axis block is normalized by its configured initial variance; all
attitude axes use the initial tilt variance. The field block uses its initial
unit variance and the transient uses its stationary variance. These scales set
the tradeoff between state errors in different units; they never clamp P.
Unobserved position/velocity origins are excluded from this relative-attitude
criterion, but their covariance and cross-covariance are still updated in full.

For any frozen gain row, CI gives `P_new[j,j] = P[j,j] / weight`. The old
attitude-only criterion ignored that cost to nuisance states. The new positive,
fixed cost makes every accepted compass update pay for it: compass corrections
alone cannot increase this cost or inflate a retained marginal without bound.
Prediction, other observations, and source reinitialization can change the cost;
this is not a long-term error bound for the complete estimator. A useful heading
observation may be declined when its unknown-correlation cost is too high.

Valid redundant or overly costly observations are reported as uninformative,
not rejected sensor faults. Inflation of other covariance blocks is retained;
silently restoring their old marginals would break the joint correlation bound.
This is conservative under unknown correlation
within the linearized model, conditional on valid input uncertainty bounds; it
cannot bound an arbitrary unreported OS error. Throttling alone is not used as a
claim of statistical independence.

## Recovery, frames and calibration gestures

Source changes qualify a provisional reference before replacing the active one,
without snapping attitude. Fresh usable raw input takes priority over OS vectors,
then Safari compass input. A lower-priority provider cannot replace an active
provider seen within 1.5 seconds. Returning preferred input must qualify too;
unqualified alternate callbacks do not advance the active source's timestamp.
Initialization,
qualification, excitation, persistent innovations and rejection state all replay
at acquisition time. Duplicates are ignored. Frame changes rotate both acceleration
components and the field, including their joint yaw-gauge covariance.

Gaps retain the learned field. A magnetic-only gap longer than one second enables
nonlinear reacquisition before the ordinary raw linear innovation gate. A failed
raw innovation with at least 20° yaw uncertainty can also enable that path, followed
by holdoff and fresh qualification. Corrections beyond the tracking range still
request recovery. None of these decisions inflates the attitude prior or replaces
the established field. A separate recovery candidate must also remain stable
in strength and world direction for two seconds/four samples; it never replaces
the established reference. Strength and inclination gates remain active; the nonlinear
update must be consistent with the actual prior. A tight conflicting prior can
therefore still reject the magnetic hypothesis. Reference/bias calibration is
frozen during recovery so it cannot absorb the attitude discrepancy. Once tilt and magnetic evidence
requalify, a heading-alignment seed and iterated update can recover corrections
beyond 30° for both raw vectors and scalar heading observations. Heading-only
recovery requires a recent accepted tilt observation and tilt standard deviation
below 10°, just as full-vector recovery does. Its seed is a rotation about world
down by minus the wrapped scalar residual, preserving nominal roll and pitch.
Each CI weight candidate uses the same original prior throughout iteration,
including its original correlation weight. Only the selected candidate commits
state, covariance and one observation report. Recovery retains the CI cost checks
and never turns an upstream fused heading into independent sensor evidence.
It can reject or fail to converge; global recovery under arbitrary acceleration/interference is not
claimed. The separate ordinary tracking update keeps its 30° limit.

No figure-eight gesture is mandatory. Relative fusion removes a fixed heading
offset; orientation-dependent distortion still matters. Excitation qualification
makes online bias learning conditional on useful motion and does not replace
platform/installation calibration.

The startup/continuation/recovery separation was compared with the actual
[PX4 magnetic controller](https://github.com/PX4/PX4-Autopilot/blob/main/src/modules/ekf2/EKF/aid_sources/magnetometer/mag_control.cpp)
and [magnetic fusion implementation](https://github.com/PX4/PX4-Autopilot/blob/main/src/modules/ekf2/EKF/aid_sources/magnetometer/mag_fusion.cpp).
PX4's model and hardware assumptions differ; its code is an architectural reference,
not performance evidence for this implementation.
Unknown-correlation fusion follows the covariance-intersection approach described
by [Julier and Uhlmann](https://www.sciencedirect.com/science/article/abs/pii/S0921889006001436).
Reacquisition follows the fixed-prior iterated-update principle described by
[Huai and Gao](https://arxiv.org/abs/2307.09237), with right-error quaternion
injection/reset as in [Solà](https://arxiv.org/abs/1711.02508).
These references do not validate this implementation or its engineering thresholds.
Subsequent deployment verification exercised these paths and exposed a recovery
guard defect: unqualified tilt must stop reacquisition rather than fall through
to ordinary tracking. The guard is now explicit for all providers. Browser
verification also motivated the pre-CI innovation gate above. Current numerical
results are recorded in the
[v6 review](../../../../docs/ahrs-validation.md#v6-beta-verification).
