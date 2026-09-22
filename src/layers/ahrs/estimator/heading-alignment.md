# Heading acquisition and recovery

Heading source and current validity are different quantities. `headingReference`
records the most recent source: none (`relative`), a one-time manual input, or
GPS/IMU motion. `headingStatus` governs navigation fusion:

| Status | Navigation frame | GPS use |
| --- | --- | --- |
| `acquiring` | Arbitrary local-level frame | Motion-based heading acquisition plus yaw-independent GPS increments, vertical velocity and altitude |
| `tracking` | Aligned to north | Local ESKF velocity/altitude corrections |
| `recovering` | Arbitrary local-level frame | The same fresh evidence paths as initial acquisition |

There is no saved manual-heading measurement to apply again. Navigation-filter
alignment and HSI availability are separate. The plugin's
[HSI policy](../README.md#heading-and-guidance-behavior) keeps available information
visible under warnings, using the geographic reference described below while
this filter seeks observable nose-heading evidence.

Heading acquisition is not a prerequisite for IMU calibration or visible pitch
and bank. A session with no GPS fix can show live relative attitude under the red
cross. The host's [display policy](../README.md#calibration-and-validity) uses GPS
availability, aiding speed and tilt uncertainty; unknown absolute heading alone
does not hide the AI or trigger the tilt-uncertainty warning.

## HSI heading reference

[HeadingReference](../heading-reference.ts) belongs to the AHRS session and exposes
`AhrsSnapshot.hsiHeading`. It prefers aligned estimator heading; otherwise fresh,
accurate, non-estimated GPS track at or above 10 m/s can seed a provisional heading.
A supplied manual heading takes precedence during calibration. This display
reference does not change the navigation filter's covariance or fusion gates.
The recorder includes both `hsiHeading` and the filter's heading status, reason
and previous source in each snapshot.

Bias-corrected gyro increments, using calibrated AHRS tilt, carry heading at IMU
cadence. A bounded three-second history matches delayed GPS track to rotation at
fix acquisition. A fix just ahead of active motion waits for the matching IMU
sample. During a motion pause, usable GPS can still establish or update the
estimate, without inventing rotation across the missing interval. Propagation
and history interpolation stop across the estimator's motion-gap limit or near
the Euler heading singularity.

Initial acquisition establishes a geographic reference immediately. Subsequent
north-reference corrections follow the shortest angular path with exponential
damping (5 s for GPS, 1 s for aligned AHRS). Corrections stop settling three seconds
after their last observation. Gyro propagation excludes navigation-frame yaw
jumps; those changes enter through the smoothed correction instead. Display reads
are pure, and stowing or switching full screen preserves the session reference.

HSI heading is considered confident only with live, non-degraded motion, aligned
filter heading, heading standard deviation at most 20°, and a displayed heading
within 5° of the filter heading. Confidence governs warnings independently of
availability. GPS loss, low speed and heading recovery retain the geographic
reference; stopping or starting a new calibration clears it.

## Tracking and recovery decisions

Ordinary tracking retains its 30° attitude-correction limit. Qualified vector
reacquisition after a motion gap uses a separate iterated update with a geometric
seed, one fixed prior and one final covariance update. Heading is released when its
model-based standard deviation exceeds 30°, or a GPS update requests an attitude
correction outside that local range. The uncertainty threshold is an engineering
limit on using a local Gaussian heading model, not a validated integrity bound.
It is larger than the motion fit's 20° maximum uncertainty, leaving room to track
after acquisition. It does not depend on elapsed flight time or the original source.

A small reported uncertainty can also be wrong. During consecutive rejected GPS
updates, `MotionHeading` may collect fresh evidence from `HeadingTrajectory`.
This separate trajectory copies the main filter's tilt/bias marginal at a fresh
boundary, then propagates every IMU sample and its own covariance without GPS
corrections. Acquisition-time checkpoints match delayed GPS to the corresponding
inertial velocity. The fitted rotation is carried to the current time using the
trajectory's own quaternion, even if the main filter's attitude has since changed.
The trajectory waits for a fresh force reading after its seed. It carries
attitude/bias uncertainty to that boundary and then initializes translation, so a force reading
already used to condition the main-filter seed is not reused as independent noise.

While tracking north, an accepted horizontal velocity correction or out-of-order
fix clears the replacement-heading evidence window. During acquisition/recovery,
[yaw-independent GPS evidence](velocity-change.md) also enters the main filter.
The fit's trajectory is not corrected by it; shared errors are bounded at the
automatic alignment transfer below.
Altitude corrections do not alter this trajectory or reset its horizontal evidence.
This shares the navigation model's independent measurement-component assumption;
it does not assert independence of arbitrary receiver altitude/velocity errors.
The ordinary motion qualification rules must succeed before replacing heading.
A single innovation outlier never discards a working alignment. Persistent
rejections alone are not enough to establish a replacement heading.

The coarse initializer searches the circle analytically using detrended horizontal
velocity cross/dot sums. A generalized least-squares fit then estimates yaw,
constant velocity offset and linear drift jointly. For trajectory samples i ≥ j:

```
P_ij = Phi(i,j) P_j
S_ij = R_yaw P_velocity_ij R_yawᵀ + delta_ij R_GPS_i
```

The independent trajectory retains fundamental transitions as well as covariance.
A pivoted linear solve obtains relative transitions without forming an inverse.
The fit therefore preserves common initial errors, gyro/accelerometer bias errors,
and integrated process-noise correlations across its entire window. GPS velocity
noise uses the configured/provided independent noise model; arbitrary undocumented
receiver time correlation remains outside that model.

The fit derives its yaw influence weights from the GLS normal matrix. Transporting
the result to the current time includes the cross-covariance between fitted offset
and current yaw, rather than adding their variances as independent quantities.
A 5° discrepancy floor remains an explicit engineering allowance. The fit needs
at least eight samples over seven seconds, informative motion, shape/scale
agreement, tilt uncertainty below 10°, and heading uncertainty at most 20°.
Three overlapping consistent solutions qualify persistence only: their covariance
is never divided by the number of confirmations. GPS track is not nose heading.

## What a frame change preserves

Releasing heading leaves the nominal quaternion and both bias estimates unchanged.
It discards the old navigation trajectory and defines a new arbitrary yaw gauge.
Absolute heading uncertainty is reported as **Infinity**, not zero.

Let `d = Rᵀ [0,0,1]`. Removing or replacing yaw acts on the complete retained
attitude/bias/acceleration/magnetic marginal. For yaw-error gradient `h`, its
gauge direction contains:

```
u_theta = d
u_persistent = worldDown × persistentAcceleration
u_transient = worldDown × transientAcceleration
u_field = worldDown × magneticField
u_biases = 0
T = I - u [h, 0, ...]
P_new = T P Tᵀ + headingVariance × u uᵀ
```

Gauge release uses `h = d` and zero new heading variance. Explicit alignment uses
the Euler yaw gradient and the supplied heading variance. Both satisfy `h·d=1`.
Both nominal world acceleration components and the field rotate with heading; their
error/cross-covariance blocks receive that same frame rotation. Body errors and
biases do not change coordinates. Relative magnetic and gravity predictions
therefore remain invariant under a pure heading-frame change.

Independent manual alignment retains down-direction and bias uncertainty.
GPS-derived heading shares IMU/seed errors and, before north alignment, GPS
increment errors with the corrected main filter. Their
cross-covariance is not available from the independent trajectory, so automatic
alignment applies the conservative bound `2(T P Tᵀ + headingVariance u uᵀ)`.
This deliberately retains additional uncertainty rather than asserting independence.
The provisional magnetic direction, innovation monitor and rotation-excitation mean rotate with the frame,
so a heading alignment cannot masquerade as magnetic calibration motion. The covariance can be
momentarily semidefinite along the chosen local-yaw gauge; numerical health checks
allow roundoff-scale semidefiniteness without adding confidence or altering the
stored covariance. Position/velocity restart independently and the velocity endpoint clone is discarded. Cumulative diagnostics
survive; a separate initialization flag prevents an old fusion time from claiming
current GPS navigation aiding.

Explicit frame changes clear replay and heading-fit history at the current IMU
time. Frequent gravity updates do not clear heading evidence. The independent
trajectory is refreshed after 30 seconds of age when no recent coherent rotation
is present. A 0.5-second average of bias-corrected gyro rate above 0.02 rad/s
defers that refresh through the turn and ten seconds afterward, allowing delayed
GPS and three confirmation fixes to arrive. An unconditional 60-second age cap
still bounds uninterrupted maneuvers. These are evidence-lifecycle limits, not
extra observations or relaxed fit gates. Magnetic and gravity corrections never
bend an already collecting inertial fit. Heading acquisition consumes its GPS
window, and only subsequent fixes may enter the newly aligned velocity filter.
Magnetic references survive frame changes and ordinary motion gaps.

## Scope and evidence

Steady flight without independent yaw-reference evidence can leave absolute
heading unobservable while tilt remains useful. This does not mean steady flight
or missing GPS must cause every yaw estimate to deteriorate: qualified magnetic
evidence can constrain yaw changes. See [AHRS uncertainty](uncertainty.md) for
the distinction between relative yaw confidence, north alignment, and the current
magnetic model's limitations. The motion-observability distinction is consistent
with [VectorNav's GNSS/INS description](https://www.vectornav.com/resources/inertial-navigation-primer/theory-of-operation/theory-gpsins).
[PX4's separate yaw acquisition/recovery implementation](https://github.com/PX4/PX4-Autopilot/blob/main/src/modules/ekf2/EKF/yaw_estimator/EKFGSF_yaw.cpp)
is an architectural reference; this implementation uses the simpler qualified
motion fit above. Neither source validates this application's thresholds.

`test/ahrs-heading-recovery.test.ts` checks finite crosswind turns after 15-minute
straight legs, manual/blank heading, sensor noise, precise/browser-scale GPS noise,
delivery delay, GPS loss, changing yaw bias, repeated recovery, wrong heading
priors, isolated outliers, and covariance transfer. Assertions cover actual tilt
and heading errors, uncertainty, correction counts and recovery timing.
Altitude-plus-recovery regressions also cover an overconfident 90° heading error,
with immediate and 1.1-second-delayed GPS. The broader numerical checks are in
`test/ahrs-mathematics.test.ts`. Current numerical results and the preserved
turn-accuracy limits are recorded in the
[v6 review](../validation.md#v6-beta-verification).
Simulations do not replace validation with recorded phone/aircraft data or prove
consistency of every mode transition.
