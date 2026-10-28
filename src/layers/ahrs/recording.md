# AHRS recordings

[Documentation](../../../docs/README.md) / Plugins / [ahrs](README.md)

The recorder stores live input and estimator output locally for comparison with
an independent reference. It does not request sensor permissions or start AHRS;
calibration still starts motion and the shared GPS lease. Recording before
calibration captures initialization. A session begun later includes the current
attitude, bias, covariance, trim and options, but not the filter's preceding
replay/reference history. It is not an exact mid-flight restart checkpoint.
Calibration and recording can proceed without ever receiving a GPS fix; the GPS
lease does not make a fix a prerequisite for live IMU attitude.

Recording belongs to the instrument session. Optional map heading leases neither
start nor end a recording prepared for calibration. Automatic heading observations
are not inserted into calibrated instrument replay. Sensor capture belongs to the
instrument session; replay begins from its confirmed alignment. Explicit instrument Stop or plugin
disposal ends the recording even if the map continues using automatic heading.

## Contents

- [GPX track download](#gpx-track-download)
- [Debug log download](#debug-log-download)
- [Offline estimator replay](#offline-estimator-replay)
- [Persistence](#persistence)

## GPX track download

**Download GPX** exports a UTF-8 [GPX 1.1](https://www.topografix.com/GPX/1/1/)
track with ZLayer AHRS extensions. Existing JSONL recordings can also be exported
as GPX. Ordinary GPX readers can use the track and ignore the extensions. The
extensions describe recorded attitude; another application's GPX support does
not imply support for AHRS replay or simulator playback.

Each `trkpt` contains WGS84 latitude/longitude, a UTC acquisition timestamp and,
when available, the browser's altitude in meters. Altitude is preserved as
reported by browser geolocation (specified as WGS84 ellipsoid height), without
geoid or pressure correction. Duplicate and out-of-order fix timestamps are
omitted. Lost/stale GPS, calibration, stopping AHRS and gaps over ten seconds
start new track segments. No positions are interpolated. Without any saved GPS
positions, GPX export reports an error and the debug log remains available.

Extensions use namespace `urn:zlayer:ahrs:1` (prefix `z`, version `1`):

| Element | Contents |
| --- | --- |
| `trkpt/extensions/z:gps` | Groundspeed in m/s, true course over ground in degrees, horizontal/vertical accuracy in meters, whether velocity was estimated, and UTC receipt time. Missing values are omitted. |
| `gpx/extensions/z:recording` | Session ID, estimator model, units/frame metadata, monotonic clock origin in epoch milliseconds, and `complete` (an explicit recording end was saved). |
| `z:configuration` | XML-escaped JSON containing the initial mount, optional true heading, trim and estimator options. |
| `z:state` | Initial snapshot and each recorded AHRS state, with independent UTC `time` and monotonic-seconds `t`; phase, warning/crossed status, roll/pitch/yaw, quaternion, heading reference/status, model uncertainty, IMU age, load, vertical speed, biases and aiding flags when available. |
| `z:event` | Calibration/alignment, sensor issues, visibility changes and stop/end events with their own `time`, `t`, `type` and XML-escaped JSON data. |

States retain their recorded rate (up to 10 Hz), independently of slower GPS
fixes. Their times describe the recorded snapshot, not a new GPS fix. Angles and
angle uncertainties are degrees; the quaternion is `w x y z`, rotating trimmed
body forward/right/down axes into the estimator's local-level frame. Yaw is
clockwise, and north alignment is valid only while `headingStatus="tracking"`.
`headingReference` alone describes alignment history, not current validity. GPS
course is separate from yaw. Nonfinite uncertainties are omitted; an absent
heading uncertainty must not be treated as zero.

`imuAge` is seconds, `load` is specific-force magnitude divided by standard
gravity, and `verticalSpeed` is positive-up m/s. `gyroBias` is rad/s and `accelBias`
is m/s², each a space-separated vector in trimmed body axes. GPX includes concise
diagnostics; raw sensor inputs, complete covariance and innovation histories
remain in the debug log for estimator replay. GPX is uncompressed XML: its size
depends on the fields/rates retained, and standardization does not itself make
it smaller than JSONL.

## Debug log download

**Debug log** exports UTF-8 JSON Lines (`.jsonl`), the same format used internally,
with one independently parseable event per
line. Each line has `sequence`, `type`, `time` and `data`. Sequence numbers start
at zero and preserve callback order, including delayed GPS observations.

`time` is receipt time in monotonic seconds. The header's `context.timeOrigin`
is epoch milliseconds: `timeOrigin + time * 1000` gives an epoch projection of the
monotonic timeline. That projection can diverge from wall time after device sleep
or clock adjustment; GPS's original epoch timestamp remains authoritative for its
acquisition UTC. The IMU sample retains its own timestamp, raw motion includes the browser's
`eventTimestamp` and `interval` in milliseconds, normalized `time`, `receivedTime`
and timestamp `clock` (`event` or `epoch-event`). GPS retains its original
epoch timestamp plus core's normalized acquisition `fix.time` (also recorded as
GPS event data `time` for existing replay readers). Core preserves source age using
the clock relationship at receipt, rather than the header's fixed origin. Receipt/acquisition times
must not be interchanged when replaying delayed observations. Browser motion
event creation time is not guaranteed to be the hardware sampling instant.

- `header`: format `zlayer-ahrs`, version `1`, unique recording ID, browser and
  built app script URL, units/frames, effective estimator options, mount, optional heading,
  current trim, visibility and initial snapshot/covariance. `context.estimatorModel`
  is `px4-ekf2-v1.17.0-browser-v4`; this versions estimator behavior separately from JSONL format 1.
  Browser v2 added automatic ground qualification and explicit PX4 flight defaults;
  v3 corrected cadence, buffer startup, heading validity and GPS/IMU ordering.
  V4 adds GPS invalidation/health continuity and corrects heading uncertainty and
  GNSS handoff after magnetic startup. Browser v1/v2/v3 recordings require their
  original revision.
  The current covariance is 24×24. Earlier kinematic models, including
  `kinematic-ahrs-v7` with its 30-state covariance, require their original revision.
- `calibrate`: selected mount and optional one-time true heading.
- `alignment`: complete calibration solution, including trim and gyro-bias
  uncertainty and optional heading. `imuHistory` contains the
  final second of actual, untrimmed calibration samples used to prime PX4's
  delayed buffers. Replay applies the recorded trim to this history before
  processing ready-state samples. Recalibration starts another segment.
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
  by its quality, innovation or alignment gates. Poor/incomplete fixes are
  forwarded so they can invalidate older ground/health evidence. A source failure
  without a new observation has `invalidated: true`, `forwarded: false`, and
  `time` equal to the monotonic receipt time. Replay applies this invalidation
  even if the source retained an older fix; that retained fix is not fused.
  Available altitude and altitude accuracy are forwarded along with velocity.
  Gravity aiding is captured in estimator options and tilt innovations/diagnostics.
- `state`: unsmoothed AHRS snapshot, at most 10 Hz while motion is arriving,
  including attitude, bias estimates, uncertainty, aiding status and fusion counts.
  `groundState` reports PX4's delayed automatic assessment (`unknown`, `landed`,
  `at-rest`). It is derived again from recorded GPS/IMU inputs during replay;
  there is no pilot mode-change event.
  `groundDiagnostics`, when present, retains the host's qualification reason,
  input magnitudes and settling timers at its own latest IMU `time`, before the
  native delay. These values remain historical during a motion pause. Units and
  fields follow the [ground qualification contract](estimator/px4/README.md#automatic-ground-qualification).
  Vibration metrics are smoothed sample differences, not sensor noise estimates.
  `unaidedYaw` is PX4's wrapped gyro-yaw accumulator in degrees, excluding aiding
  and reset jumps. The HSI uses its increments; it restarts with the native
  estimator and is absent in historical snapshots.
- `magnetic`: source-labelled measurement with its own monotonic timestamp and
  forwarding decision. Current sensing records only platform-calibrated XYZ
  fields in µT. Historical recordings can also contain OS-fused unit orientation
  vectors or scalar compass heading/accuracy in degrees. Vectors and compass
  reference axes are in the **trimmed estimator body frame**; replay does not
  apply the mount trim again. PX4 rejects historical OS-fused magnetic inputs.
- `magnetic-issue`: optional compass/sensor failure or pause. Marks the aid
  unavailable while IMU/GPS continue. Buffered pre-failure measurements can
  finish at the delayed horizon; PX4 stops fusion through its sensor timeout.
  The learned reference persists; the issue is also replayed.
- `innovation`: each reported PX4 velocity, altitude, gravity or magnetic aid
  source's acquisition time, dimension, residual, variance diagnostic and result.
  `covarianceKind: sequential-diagonal` identifies the per-axis variances exposed
  by PX4; zero off-diagonal entries do not assert independent joint errors.
  `gateKind: per-axis-sigma` identifies the upstream scalar gate convention.
  The sum of squared normalized residuals is descriptive, not a joint chi-square
  acceptance test. Gravity residuals use unit-vector components, magnetics use
  gauss, velocity m/s and height metres. Browser velocity observations are 2D
  unless actual NED velocity is provided. Internal fake-position/height and
  zero-rate/zero-velocity updates are not included in these sensor-aid counters.
  PX4 buffers delayed observations instead of replaying the full event history;
  its reports have `replayed: false`. Historical models used different
  residual units and joint-covariance semantics; use their original recording
  contract when interpreting those files.
- `covariance`: complete row-major 24×24 covariance, at most 1 Hz. State order is
  NED attitude error (3), velocity (3), position (3), gyro bias (3), acceleration
  bias (3), earth magnetic field (3), body magnetic bias (3), horizontal wind (2),
  terrain (1). Angular errors use radians and magnetic fields use gauss. Unknown
  north remains explicitly unknown even if the local yaw covariance is small.
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
one-time heading input. It emits PX4 states, heading transitions, innovations
and a summary. The summary compares attitude/covariance with the recorded output
and reports NIS by source, counting each source/acquisition time once per
calibration segment. Only the current PX4 model is supported. Other or missing
model identifiers, including `kinematic-ahrs-v7`, are rejected with an instruction
to use the original estimator revision; they are never reinterpreted as PX4.
Existing recordings remain downloadable regardless of replay compatibility.
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
existing `zlayer-offline` database. Listing sessions reads metadata only. Exporting
an active session gives a snapshot of its committed prefix. An interrupted or
active GPX export is still a complete XML document, with `complete="false"`.
Separate windows use unique session IDs.
The list validates format version, ID, representable timestamps, status and
positive safe-integer counters before rendering a saved entry. Malformed metadata
is omitted from the list without deleting its stored metadata or sample chunks.

Both exports run in a dedicated worker. Input is read sequentially in at most
64 KiB pieces; GPX uses two passes so track points precede independently timed
attitude samples without buffering a flight. Output is appended to a temporary
file in the browser's origin-private file system (OPFS), then downloaded using
a disk-backed File. GPX entries over 1 Mi characters are rejected to bound parsing
memory. Cancelling an export or unmounting the recorder control terminates its worker.

If disk export is unavailable (including private WebKit sessions) or storage is
full, a fallback accepts at most 8 MiB of output. A quota failure during writing
or flushing closes/removes the partial disk export and retries from the saved
source within this same limit. Larger fallback exports report an error asking
the user to free/enable local storage; a smaller GPX may still be downloadable.
Saved recordings remain available after an export failure. These are application
buffer limits, not a guarantee of total browser memory usage or iOS background
execution.

Temporary exports use the OPFS `zlayer-exports` directory. Failed/cancelled
exports are cleaned up. Repeating the most recent download of the same committed
prefix reuses its URL and renews a five-minute window for mobile Save/Share. A
different export releases any previous fallback Blob before preparing more data;
only one fallback payload is retained at a time. Disk-backed files keep their
five-minute window. Scratch files left by a closed
or crashed tab are removed on a later export once they are over a day old.
**Delete all local data** removes recordings and this scratch directory. An
unavailable OPFS root does not block reset; a failure to delete an accessible
scratch directory is still reported and remains retryable.

Each saved session also has a **Delete** action, using core's
[shared destructive confirmation](../../../docs/features/shared-ui.md#shared-controls).
Stop an active recording and let it finish saving before deleting it; completed and interrupted
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
