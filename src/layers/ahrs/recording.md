# AHRS recordings

The recorder stores live input and estimator output locally for comparison with
an independent reference. It does not request sensor permissions or start AHRS;
calibration still starts motion and the shared GPS lease. Recording before
calibration captures initialization. A session begun later includes the current
attitude, bias, covariance, trim and options, but not the filter's preceding
replay/reference history. It is not an exact mid-flight restart checkpoint.
Calibration and recording can proceed without ever receiving a GPS fix; the GPS
lease does not make a fix a prerequisite for live IMU attitude.

## Download format

Files are UTF-8 JSON Lines (`.jsonl`), with one independently parseable event per
line. Each line has `sequence`, `type`, `time` and `data`. Sequence numbers start
at zero and preserve callback order, including delayed GPS observations.

`time` is receipt time in monotonic seconds. The header's `context.timeOrigin`
is epoch milliseconds: `timeOrigin + time * 1000` gives the corresponding epoch
time. The IMU sample retains its own timestamp, raw motion includes the browser's
`eventTimestamp` and `interval` in milliseconds, normalized `time`, `receivedTime`
and timestamp `clock` (`event` or `epoch-event`). GPS retains its original
epoch timestamp plus the converted acquisition time. Receipt/acquisition times
must not be interchanged when replaying delayed observations. Browser motion
event creation time is not guaranteed to be the hardware sampling instant.

- `header`: format `zlayer-ahrs`, version `1`, unique recording ID, browser and
  built app script URL, units/frames, effective estimator options, mount, optional heading,
  current trim, visibility and initial snapshot/covariance. `context.estimatorModel`
  is `kinematic-ahrs-v6`; this versions the equations separately from JSONL format 1.
  v6 adds rotation-dependent acceleration process noise and protects the heading
  trajectory from a periodic reset during a turn. Its covariance remains 30×30;
  matching dimensions alone do not establish replay compatibility with v5.
  Earlier estimator models require their original revision for replay.
- `calibrate`: selected mount and optional one-time true heading.
- `alignment`: complete calibration solution, including trim, force and gyro
  bias/uncertainty; heading is recorded separately. Recalibration creates another
  event in the same session.
- `imu`: motion-adapter samples, before the calibration trim, and
  raw browser gyro/accelerometer channels where available. Gyro is rad/s and
  force is m/s². `phase` identifies calibration/ready state; `applied` identifies
  samples passed to calibration/the estimator. Invalid inputs have `applied: false`.
  Every valid ready-state sample is applied while stowed; older files may contain
  explicitly skipped samples.
  Raw gyro channels have already been converted to radians;
  raw acceleration precedes platform polarity correction.
- `gps`: source state and fix, including coordinates, altitude, reported accuracy,
  speed/track, estimated-velocity flag, converted time and whether the observation
  was forwarded to the estimator. Forwarded observations can still be rejected
  by the estimator's innovation or alignment gates.
  Available altitude and altitude accuracy are forwarded along with velocity.
  Gravity aiding is captured in estimator options and tilt innovations/diagnostics.
- `state`: unsmoothed AHRS snapshot, at most 10 Hz while motion is arriving,
  including attitude, bias estimates, uncertainty, aiding status and fusion counts.
- `magnetic`: source-labelled magnetic vector or compass heading/reference axis,
  with its own monotonic timestamp and forwarding decision. Field vectors are
  platform-calibrated µT readings; browser orientation vectors are unit length
  and already OS-fused. Vectors and compass reference axes are in the **trimmed
  estimator body frame**. The scalar compass heading and accuracy remain in
  degrees as reported by the browser. Replay does not apply the mount trim again.
- `magnetic-issue`: optional compass/sensor failure or pause. Clears magnetic
  pending input and marks the aid unavailable while IMU/GPS continue. The learned
  reference persists; the issue is also replayed.
- `innovation`: each velocity, velocity-change, altitude, gravity/acceleration or magnetic
  correction's acquisition time, source, dimension, residual, full row-major
  innovation covariance, NIS, chi-square gate and acceptance/rejection result.
  `iterations` identifies fixed-prior nonlinear reacquisition; its residual is
  recentered against that prior. `priorWeight` identifies covariance intersection;
  its covariance is a conservative correlation bound, not an independent-noise
  prediction. A nonlinear correlated-heading recovery report contains both fields;
  discarded iteration/weight candidates are not additional observations.
  Valid redundant compass observations, or those whose retained-state uncertainty
  cost outweighs the attitude benefit, can be `uninformative`.
  Initialization has no innovation covariance/NIS. Velocity statistics exclude
  altitude updates. Delayed fusion
  can emit a revision with `replayed: true`; within a calibration segment, the
  latest `(source, time)` replaces earlier reports for statistical analysis.
  Raw magnetic innovations are three-dimensional, in fractions of the initial
  field norm; browser-compass innovations are scalar radians. Gravity innovations
  are three-dimensional m/s². `velocity-change` reports a two-dimensional
  local velocity-increment residual in m/s; its directional mixture retains
  additional posterior spread. Its reported NIS is a local gate diagnostic,
  not a claim of a chi-square distributed radial likelihood. Unknown north remains unknown.
- `covariance`: complete row-major 30×30 covariance, at most 1 Hz. State order is
  position, velocity, local attitude error in radians, accelerometer bias, gyro
  bias, persistent world acceleration, world magnetic reference, body magnetic
  bias, transient world acceleration and cloned endpoint velocity (three axes each). Magnetic covariance uses normalized field units. Before heading alignment the navigation frame is relative, not north.
- `visibility`, `document-visibility`, `issue`, `stop`: lifecycle and sensor issues.
  An issue with `recoverable: true` keeps the session running for the next good reading.
- `end`: explicit end reason. A file without `end` is a committed partial session.

In a `state` event, `crossed: true` does not mean attitude is absent or frozen.
After calibration, **No GPS**, **Low Speed** and **Uncertainty** accompany live
attitude while motion remains current and uninterrupted. A `degraded` attitude
status indicates high tilt uncertainty while propagation continues. **Motion**
holds the last attitude during a pause; fresh readings resume automatically with
increased uncertainty after a gap. Consumers must distinguish these states from
incomplete calibration; see the [display policy](README.md#calibration-and-validity).

Nonfinite numbers are encoded as strings (`"Infinity"`, `"-Infinity"`, `"NaN"`),
preserving unaligned heading uncertainty separately from absent values (`null`).
GPS coordinates are included. There is no automatic upload.

## Offline estimator replay

From the repository, run:

```sh
node --import=tsx tools/ahrs-replay.ts recording.jsonl > replay.jsonl
```

The runner starts from each recorded calibration solution and processes inputs
in receipt order, preserving acquisition times, trim, forwarding decisions and
one-time heading input. It emits current-algorithm states, heading transitions,
innovations and a summary. The summary compares attitude/covariance with the
recorded output and reports NIS by source after replacing replay revisions.
Older or missing estimator model identifiers are explicitly rejected: retain the
original code revision to replay those files. Existing recordings remain readable
and downloadable; replay does not pretend the 15-state equations match this model.
This replays
the estimator; it does not independently rederive the calibration solution.

Sequence gaps and applied input without a recorded alignment are rejected.
Recording before calibration is required for a complete estimator replay; a
mid-flight header is insufficient. A committed prefix without `end` can be
replayed and is labeled incomplete. NIS checks model agreement, while measured
attitude error and NEES require an independent reference or known simulation truth.

## Persistence

One writer flushes approximately every second or at 128 Ki characters. Chunks
are bounded, and their metadata commits in the same IndexedDB transaction. The
pending buffer is limited to about 2 Mi characters; a slower writer stops capture
and drains what it has. Quota/storage failures stop recording and retain the
previously committed prefix without interrupting the attitude estimator.

Metadata uses `ahrs-recording:` keys and chunks use `ahrs-samples:` keys in the
existing `zlayer-offline` database. Listing sessions reads metadata only. Export
reads that session's committed chunks and builds a local Blob download; exporting
an active session gives a snapshot of its saved prefix. Separate windows use
unique session IDs. **Delete all local data** also deletes these recordings.

Each saved session also has a **Delete** action, with confirmation. Stop an active
recording and let it finish saving before deleting it; completed and interrupted
sessions can be removed individually. Deletion removes metadata and all matching
sample chunks in one transaction, without using a potentially stale chunk count.
Other recordings and offline data remain available. Previously downloaded files
are separate copies and are not removed by this action.

The recorder drains any outstanding write after a capture error before deleting
its current session, then clears that session's snapshot. Subsequent writes require
the metadata to exist in the same transaction, preventing a late writer in another
window from recreating a deleted recording. If deletion fails, the saved entry
remains available and the menu reports the failure.

Closing/crashing the page can lose the uncommitted tail. Background flushes are
best effort, not a guarantee of background recording or completion. Browser
eviction/site-data clearing can remove stored recordings; download sessions to
keep a separate file. There is no automatic resume after reload.
