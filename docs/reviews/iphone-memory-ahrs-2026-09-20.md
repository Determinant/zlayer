# iPhone memory and AHRS scrolling review

Reviewed the current working tree on 2026-09-20, including the resource reductions
documented in [memory-resources.md](../memory-resources.md). Those existing changes
were already present. This follow-up changes only AHRS session-history cleanup.
No physical iPhone or iOS process-memory trace was available.

## Finding and fix

Stopping AHRS removed sensor listeners, its GPS lease and display timer, but the
mounted layer still retained the estimator's replay checkpoints and independent
heading trajectory. Beginning another calibration retained them until that
calibration completed. This was unnecessary retention of the last session, not
an ever-growing history across sessions.

`src/layers/ahrs/layer.ts` now resets that history on Stop/cancel and when beginning
a new calibration. It also discards the raw calibration window after applying its
trim/bias and stops feeding later GPS fixes into that completed calibration.
Background operation and automatic recovery from sensor gaps keep their state.
No estimator equations, input sampling, display cadence or validity thresholds
changed.

A local Node 24.15.0 probe used the production layer, synthetic 60 Hz level IMU
readings, no GPS and no recording, for 120 simulated seconds. It measured after an
event-loop turn and forced garbage collection:

| Process ArrayBuffer storage | Before cleanup | After cleanup |
| --- | ---: | ---: |
| Active, each checkpoint at 30/60/90/120 seconds | 5,310,106 bytes | 5,310,106 bytes |
| Stopped, layer still retained | 5,310,106 bytes | 36,466 bytes |

The stopped case releases approximately **5.03 MiB** of buffers. The active case
plateaued over this input sequence. These are process ArrayBuffer totals from
isolated Node runs, not Safari RAM, peak allocation, GPU memory, or proof about
every sensor sequence. Short-lived matrix allocations still create GC work.

Reproduce the retained-memory check with:

```sh
node --expose-gc --import=tsx tools/benchmark-ahrs-memory.ts
```

Absolute totals vary with the Node/module environment; compare active versus
stopped in the same process. For the before/after table, only the layer cleanup
patch differed between the two source runs.

## Scrolling assessment

There is no scroll handler that intentionally pauses AHRS. `motion.ts` receives
motion on the main thread and immediately updates the estimator. `instruments.tsx`
draws through `requestAnimationFrame`, capped at 60 Hz; the status/HSI publication
timer runs at 20 Hz. Hidden displays cancel their animation and publication work.

Two different effects can look like a frozen horizon:

- Delayed/missing motion events hold the last observed attitude. At more than
  0.5 seconds of sensor age, the display shows **Motion**. Calibration excludes
  missing time and retains progress; calibrated operation automatically resumes
  with fresh input and accounts for the uncertainty of unobserved movement.
- Delayed rendering can freeze the displayed horizon even if sensor events are
  still arriving. If the main thread cannot run, neither JavaScript nor its stale
  warning can update until execution resumes.

WebKit documents that script, layout and painting share main-thread work, and that
scrolling can increase painting work. This supports main-thread contention as a
possible explanation; it does not establish the cause of this user's freeze or a
rule that every iPhone must pause sensors while scrolling.
[WebKit CPU timeline](https://webkit.org/blog/8993/cpu-timeline-in-web-inspector/).

A brief pause that resumes is compatible with the recovery logic. A prolonged
foreground freeze, forced recalibration, or page reload should be investigated.
An AHRS recording already includes event time and callback receipt time in raw
IMU records, useful for distinguishing delayed delivery from missing input.

## Remaining aggregate memory exposure

The inspected paths have useful local bounds, but no shared total RAM budget:

| Path | Bound or cleanup | Remaining exposure |
| --- | --- | --- |
| AHRS | Three-second default replay window; 3,000 main-history event cap; 121 diagnostic points; recorder backpressure; export worker | Matrix temporaries, replay work and main-thread React/SVG work still need device profiling. |
| Terrain | 128 decoded 256×256 Float32 grids, four active reads/render jobs, bitmap/canvas disposal | 32 MiB of DEMs plus vector results and GPU textures; vectors are count-bounded and visible coverage can exceed the usual tile budget. |
| Modern charts | 16 fast readers, each package at most 4 MiB; readers evicted/disposed | Roughly 64 MiB of compressed package payloads plus decoder heap, in-flight work and textures. Legacy chart readers are count-bounded, not byte-bounded. |
| PDF viewer | Serialized renders; 8,388,608-pixel cap per canvas; temporary canvases zeroed | Display and replacement canvases can total 64 MiB before PDF.js resources. Map placement can add separate canvases/textures. |
| Obstructions/history | 64 KiB compressed input slices; display-height filtering for the obstruction index | Whole-document history parsing and national reference data can still allocate large transient strings/objects. |
| Map/reference data | Layer cleanup, bounded resource entries and source-update deduplication | MapLibre framebuffer/tile memory and whole-document reference caches have no combined byte cap. |

These categories can overlap. Their limits are not a worst-case app-memory sum
and cannot establish that WebKit will never terminate the page. The relevant
device check is cold load plus charts/terrain/PDF/AHRS together, followed by
repeated toggles, panning, scrolling, Stop and background/foreground cycles.
Capture CPU, JavaScript allocations and memory during the actual symptom; heap
size alone omits images and layer memory.
[WebKit memory tools](https://webkit.org/blog/6425/memory-debugging-with-web-inspector/).

## Verification

- `npm run check`: import boundaries and strict TypeScript passed.
- `node --import=tsx --test test/ahrs-*.test.ts`: **257 passed**.
- Production-build Playwright checks: **8 WebKit and 8 Chromium cases passed**
  using Playwright 1.63.0's Linux container. They cover queued/duplicate motion,
  calibration and attitude recovery while scrolling at 390×844 and 744×1133,
  Background operation, document visibility and Stop with a separate map GPS lease.
- `tools/benchmark-ahrs-memory.ts` reproduced flat retained ArrayBuffer storage
  across the active checkpoints and its release on Stop.

The initial WebKit attempt exposed an existing fixture issue: its native
`DeviceMotionEvent` interface was not constructible. The fixture now supplies an
Event-based synthetic motion constructor only when construction is unavailable.
The two scroll regressions now cover phone as well as tablet dimensions. Their
scrolling and sensor gaps are simulated; they do not reproduce iOS hardware,
native touch/compositor scheduling, thermal conditions or process-memory limits.

Focused browser command, repeated with `--browser=chromium`:

```sh
npx playwright test test/e2e/ahrs.spec.ts --browser=webkit \
  --grep 'scrolling|queued motion|page visibility|Background freezes|stop clears GPS'
```

This is a focused review and regression pass, not an all-green claim for the full
application suite or a guarantee against iPhone WebKit termination.
