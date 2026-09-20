/** Version the equations separately from the recording container format. */
export const ESTIMATOR_MODEL = 'kinematic-ahrs-v6';
export const N = 30;
export const ACCELERATION = 15;
export const MAGNETIC_FIELD = 18;
export const MAGNETIC_BIAS = 21;
export const TRANSIENT_ACCELERATION = 24;
/** A stochastic clone of velocity at a GPS endpoint. Navigation resets discard it. */
export const VELOCITY_ANCHOR = 27;
export const MAGNETIC_BIAS_STD = .1; // fraction of the initial field magnitude
export const MAGNETIC_FIELD_WALK = .0002; // normalized field / sqrt(s)
export const MAGNETIC_BIAS_WALK = .0005;
