# Joint acceleration and gravity observations

The default `kinematic-ahrs-v7` estimator consumes gyros as process inputs and
accelerometers as observations. Every fresh force sample is fused once, at its
acquisition time. GPS velocity and altitude update the same kinematic state.
There is no GPS/gravity exclusion timer, receipt-based suppression, accelerometer
subsampling, or navigation restart before a force observation. Rejected GPS fixes
cannot starve accelerometer corrections.

## State and dynamics

The 30-component error state is ordered as position, velocity, right/body attitude
error, accelerometer bias, gyro bias, persistent world acceleration, world magnetic
reference, body magnetic bias, transient world acceleration, and a cloned GPS-endpoint velocity (three axes each).
The nominal quaternion maps body FRD to the local-level world frame.

```
p_dot = v
v_dot = a_persistent + a_transient
q_dot = 0.5 q ⊗ [0, gyro - gyroBias]
a_persistent_dot = slowDrivingNoise
a_transient_dot = -a_transient / tau + drivingNoise
```

Persistent acceleration has an initial per-axis standard deviation of 1.5 m/s²
and a slow random walk, `persistentAccelerationWalk = 0.03 m/s²/√s`. Its nominal
value is never pulled to zero. Unlike a perfectly constant parameter, its
uncertainty can reopen after GPS learns a previous acceleration regime. This
adds `persistentAccelerationWalk² dt` to each acceleration variance, with the
matching velocity/position process-noise cross terms during propagation. It
does not establish that a later force change is acceleration rather than tilt.
The transient is a Gauss–Markov process, with default correlation time 5 s and
quiet-flight driving noise density 0.6 m/s²/√s. At zero rotation its stationary
standard deviation is about 0.95 m/s² (roughly 0.1 g). Coherent rotation increases
the driving variance, allowing maneuver acceleration to change without making a
spurious gyro-bias/tilt correction the cheaper explanation:

```
rateMean_dot = (gyro - gyroBias - rateMean) / 0.5 s
jerkAllowance = 2 g |rateMean|
transientDrivingVariance = accelerationWalk² + 2 tau jerkAllowance²
```

A body-fixed force rotates into the world frame with derivative `R (omega × f)`.
The 2 g scale supplies a maneuver allowance for that term; over one correlation
time its acceleration scale is `jerkAllowance × tau`. An OU process with driving
variance `2 tau jerkAllowance²` has that stationary variance. The allowance is
isotropic and adds to the nonzero quiet-flight diffusion. Translation with no
rotation remains possible; no acceleration or attitude mean is assigned from
the rate. The rate average attenuates alternating angular vibration before
squaring, and is retained in replay checkpoints and navigation restarts.

These are engineering assumptions, not measured acceleration bounds or a claim
that rotation identifies translational acceleration. They were evaluated against
the same steady-flight, maneuver and magnetic-fallback limits; a single fixed
driving density could not provide the intended response in both regimes.
The process integral includes the full position/velocity/acceleration covariance,
and no covariance or reported uncertainty is clamped to obtain the improvement.
Only the transient decays. The persistent random walk deliberately permits
uncertainty growth when acceleration remains unobserved; it is not a display
floor or a promise of bounded tilt for arbitrary sustained maneuvers.

`kinematics.ts` integrates the nominal acceleration/velocity/position dynamics
analytically over each step. Covariance uses the shared second-order transition
and matching positive-semidefinite process-noise integral, with steps bounded by
20 ms, rotation, and the transient time constant. GPS directly constrains the
integral of both acceleration components through their velocity cross-covariance.
Before north alignment, [velocity-change magnitude](velocity-change.md), direct
vertical velocity and altitude remain available. The endpoint clone is constant
between fixes; it has no independent process noise and is discarded on navigation reset.

## Observation and observability

```
u = Rᵀ(a_persistent + a_transient - g)
f_measured = u + b_accel + noise
H_theta = [u]×
H_b_accel = I
H_a_persistent = H_a_transient = Rᵀ
```

All three force axes enter the joint update. Per-reading variance is
`accelNoise² / sampleDt + 0.3² + vibrationVariance` in (m/s²)². The process model
does not also inject that accelerometer noise into velocity. This permits
simultaneous force and GPS observations without counting the force twice.

`imu-noise.ts` maintains time-aware first-order force/rate means with a 0.25 s
time constant. It averages each axis's squared force residual about that mean
with a 0.5 s time constant, then uses the largest axis variance as an isotropic
addition to measurement variance. Every delivered sample contributes; all gains
use actual elapsed time. This is an adaptive noise allowance, not a replacement
force measurement or a second attitude observation. Gyro propagation and force
fusion retain raw samples at their acquisition times, with no added signal delay
or downsampling. The configured noise floor remains in place. Coherent changes
can temporarily increase the allowance too; they still enter the kinematic model
and GPS updates are unaffected.

Without this allowance, strong symmetric vibration can repeatedly trip the
innovation gate. Fusing only the surviving phases can create a false mean and
tilt/bias drift even when the original force noise averages to zero. The allowance
reduces that phase selection and the influence of each noisy sample. These time
constants and noise envelopes are engineering assumptions. Adaptive variance
estimated from the same stream does not make the NIS exactly chi-square or prove
independent sensor noise; covariance coverage still needs measured-data validation.

The noise statistics are derived only from chronological IMU inputs, independently
of GPS corrections. Each force event retains its variance and steady means in
the replay history, so delayed fusion reuses the original values. Reset and IMU
gaps clear the running statistics; missing intervals are never averaged into a
reading. Raw recordings reproduce the statistics under model v7.

This software cannot undo sensor clipping, aliasing before browser delivery or
vibration rectification into a DC bias. See the primary descriptions of
[vibration isolation and sampling limits](https://docs.px4.io/main/en/assembly/vibration_isolation)
and [MEMS vibration rectification](https://www.analog.com/en/resources/technical-articles/vibration-rectification-in-mems-accelerometers.html).

Without recent accepted GPS velocity, accelerometer-bias gain rows are zeroed
(a Schmidt update). Its uncertainty and correlations remain in the complete
Joseph covariance update. Quiet readings therefore cannot silently calibrate
accelerometer bias by exchanging it for tilt or sustained acceleration. With GPS,
the full gain can correct the observable combinations. Gyro biases remain eligible
for correction by reference-vector history.

The persistent acceleration/tilt/bias ambiguity is physical. A fixed attitude and
constant force do not independently identify every state. This model supports
relative drift correction without repeatedly asserting zero acceleration; it does
not guarantee bounded uncertainty in every direction for arbitrary motion or
interference. Covariance is never clamped to produce a reassuring display.

## Recovery, timing and explicit strapdown mode

Loads below 0.1 g are excluded from attitude aiding. Other accelerations are
handled by the kinematic state and innovation gate, rather than treating every
maneuver as a bad gravity reading. Gap recovery ages the transient exactly and
adds `density² × elapsed time` to retained accelerometer-bias, gyro-bias,
magnetic-reference and magnetic-bias variances. The kinematic mode also ages
persistent acceleration. The caller adds a separate unknown-motion attitude
allowance and resets navigation; no missing gyro/force samples are invented.
Gap aging retains the last maneuver driving variance for the missing interval;
the rate average then restarts from fresh samples. A missing interval cannot
establish quiet-flight noise by itself.

After a gap or a correction beyond the normal tracking range, at least one second
of consecutive readings whose 0.25 s averaged force has 0.85–1.15 g load
and averaged bias-corrected gyro magnitude is below 0.05 rad/s qualifies nonlinear tilt
reacquisition. These conditions are a model qualification, not proof of rest.
The averages prevent rapid, bounded vibration from restarting qualification on
every sample. The actual force observation, its variance and the raw 0.1 g
exclusion remain in force.
A vector-alignment seed initializes an iterated update about the original prior.
Each iteration relinearizes the same observation; covariance and diagnostics are
committed once. Nonconvergence, innovation failures and bias limits reject the
update. Ordinary tracking retains its 30° correction limit.

`gravityAiding: false` retains the explicit conventional strapdown INS mode used
for comparison and gyro-only attitude coasting: accelerometer force is a process
input, and no acceleration/gravity observation is fused. GPS can still correct
that INS through velocity/attitude covariance. The independent heading-acquisition
trajectory also uses strapdown propagation, never the main filter's corrected
kinematic velocity.

The diagnostics and recorder report force observations, GPS observations and
magnetic observations separately. Delayed observations replay all state and
qualification history. Numerical results and model assumptions are recorded in
the [v7 regressions](../validation.md#v7-vibration-and-hsi-regressions) and historical
[v6 review](../validation.md#v6-beta-verification);
static checking alone does not establish tuning, accuracy or convergence.
