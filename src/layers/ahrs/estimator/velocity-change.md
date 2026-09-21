# GPS aiding before north alignment

`kinematic-ahrs-v6` uses GPS during heading acquisition and recovery. Altitude
observes down-position; directly supplied vertical velocity observes down-velocity.
Neither requires yaw. Horizontal GPS supports the magnitude of a velocity change
in the local frame. It does not supply aircraft heading or assert zero rotation.

## Endpoint state and noise

For two fixes, retain `rho = norm(v_gps_end_NE - v_gps_start_NE)`. A rotation about
down leaves this magnitude unchanged. With isotropic horizontal receiver noise,
its distribution depends on the magnitude of the true local velocity change,
without depending on the unknown north offset. Discarding direction loses useful
information during maneuvers; full vector fusion resumes after north alignment.

At the first endpoint, clone the current local velocity into state indices 27–29.
Its covariance and cross-covariance are exact copies, obtained by a deterministic
state transform. This is a copy of the uncertain physical velocity, not an
independent GPS observation. Propagation leaves the clone fixed; all subsequent
corrections retain its cross-covariance and update its mean when the gain allows.
Thus shared velocity-origin error cancels from the increment likelihood.

Pairs span 2–15 seconds. Intermediate fixes do not reset the anchor. Each ending
fix is consumed and cannot become the next starting fix. A longer gap discards
the anchor and starts a fresh pair. The endpoint's three rows are marginalized
after use, without changing the retained marginal. Navigation/frame resets also
discard it. Exact clones and discarded zero rows make the joint covariance
positive semidefinite; they do not require artificial process noise.

Each endpoint uses the largest supplied horizontal velocity standard deviation,
or the configured default, floored at 0.05 m/s. Squared endpoint deviations sum
to the isotropic increment noise `r`. Receiver errors at disjoint fixes are
assumed independent, as in the existing vector-GPS model. Undocumented receiver
time correlation and the nonlinear effect of replacing anisotropic noise with
an isotropic envelope remain model limitations.

## Radial observation

The beta factor admits near-steady observations `rho <= 3 sqrt(r)`. This does not
set measured acceleration to zero: the nonzero radius remains in the likelihood.
Large observed maneuvers are left to the separate heading fit and other aids.

```
d = v_local - v_anchor                         (horizontal components)
H = [0, I_horizontal_velocity, ..., -I_horizontal_anchor]
S = H P Hᵀ + r I
y_k = rho [cos(alpha_k), sin(alpha_k)]           (64 equally spaced angles)
w_k ∝ exp(-0.5 (y_k - d)ᵀ S^-1 (y_k - d))
y_mean = sum(w_k y_k)
C_y = sum(w_k (y_k - y_mean)(y_k - y_mean)ᵀ)
K = P Hᵀ S^-1
dx = K (y_mean - d)
P_new = P_conditional + K C_y Kᵀ
```

`P_conditional` is the ordinary Joseph posterior using `r I`. The final positive
spread term preserves the direction ambiguity; omitting it would overstate the
information in the magnitude. At zero radius this becomes the ordinary Gaussian
zero-increment observation. Unlike differentiating `norm(d)`, angular integration
remains defined at zero predicted change. Stable weights subtract the smallest
NIS before exponentiation. The near-steady limit bounds the concentration that
the angular quadrature must resolve. The state posterior is a local Gaussian
moment approximation, followed by the normal quaternion injection/reset.

The nearest directional hypothesis must pass the two-dimensional 13.816 gate.
The mean correction also passes the normal covariance, innovation, attitude and
bias limits. Reported NIS describes these local gates; it is not a calibrated
chi-square statistic for the marginalized radial measurement. Receiver uncertainty,
quadrature accuracy and nonlinear attitude approximation require numerical checks.

## Heading, replay and evidence

Accepted increments can correct acceleration, tilt and observable bias combinations
through the joint covariance. They cannot independently establish north or guarantee
every yaw-bias component is observable. The heading trajectory remains independent
of main-filter corrections. It may use the same GPS fixes; automatic alignment
already bounds its unknown correlation with the main state using the documented
factor-two covariance transfer. Its fitting window is not subsequently fused into
the newly aligned navigation state.

GPS events retain their alignment mode, and the complete endpoint state is part
of each replay checkpoint. Delayed fixes therefore rebuild endpoint selection and
fusion at acquisition time. Explicit frame changes flush history.

This factor is an application-specific derivation, not a PX4 port. Regression
sources cover closed-form zero/nonzero-radius posteriors, rotation invariance,
disjoint endpoints, gaps, resets, vertical aiding, two-minute intermittent-GPS
flight and delayed delivery. These checks passed in the
[v6 beta verification](../../../../docs/ahrs-validation.md#v6-beta-verification).
