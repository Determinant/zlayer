# Heading alignment

Live estimation uses [pinned PX4 EKF2](px4/README.md).

## HSI heading reference

The session-owned [heading reference](../heading-reference.ts) keeps a geographic
display reference across GPS loss, stowing and estimator recovery. Fresh usable
GPS track seeds a provisional reference; a currently aligned manual/GNSS heading
takes precedence. Ground track does not become a nose-heading observation in PX4.

Motion between fixes comes from differences in PX4's `getUnaidedYaw()` accumulator,
exposed as `Attitude.unaidedYaw` in degrees. It includes the upstream bias and
coning corrections, excluding aiding corrections and navigation-frame reset
jumps. The HSI unwraps these differences without a second gyro integrator. Gaps,
interrupted motion and near-vertical pitch break interpolation; the existing
geographic reference is retained, and missing motion is not extrapolated.

Three seconds of timestamped motion history match delayed GPS fixes to their
acquisition time. A slightly future fix waits for the corresponding IMU input;
during a motion pause it can still establish an estimate under the warning.
Reference corrections follow the shortest arc with a five-second GPS or
one-second aligned-heading time constant, and stop pursuing an observation after
three seconds. Display reads do not advance state. Explicit recalibration clears
this history; estimator recovery preserves it while restarting the native
unaided-yaw accumulator.
