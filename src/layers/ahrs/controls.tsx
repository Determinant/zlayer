import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoutePlan } from '@zlayer/domain';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { usePersistentState } from '../../core/ui/use-persistent-state';
import { isBoolean } from '../../core/storage/ui-state';
import type { Mount } from './estimator/device-frame';
import type { FlightAlignmentReason } from './estimator/flight-alignment';
import type { AhrsLayer, AhrsSnapshot } from './layer';
import { AhrsInstruments } from './instruments';
import { AhrsDiagnostics } from './diagnostics';
import { Hsi } from './hsi';
import { InstrumentTest } from './instrument-test';
import { useMagneticModel } from './use-magnetic-model';
import { AhrsWindow, AhrsFullScreenButton } from './full-screen';
import { AhrsRecorderControl } from './recorder-control';
import './styles.css';

const reasons: Record<FlightAlignmentReason, string> = {
  'collecting-imu': 'Hold roughly steady and level. Small movements and vibration are okay; GPS is optional.',
  'pose-changed': 'Device position changed during the pause. Collecting a new level reference.',
  'imu-stale': 'Motion readings paused. Collected readings are kept; calibration resumes automatically.',
  'imu-unstable': 'Waiting for steady sensor readings. Keep the device supported and level.',
  'collecting-gps': 'Waiting for a steady GPS track.',
  'gps-unusable': 'Waiting for accurate GPS speed above 20 kt and a steady track.',
  'gps-stale': 'Waiting for a fresh GPS fix.',
  'gps-unstable': 'Speed or track is changing. Hold steady.',
  'vertical-evidence-unavailable': 'Waiting for level-flight confirmation.',
  'vertical-motion': 'Climb or descent detected. Hold level.',
  ready: 'Applying calibration…',
};

function attitudeStatus(state: AhrsSnapshot): string {
  if (state.attitude?.tiltAiding) {
    return `${state.message ? `${state.message} ` : ''}Calibrated · gravity aiding active${state.gpsLive ? '' : ' · GPS unavailable'}`;
  }
  if (state.warning === 'No GPS' || state.warning === 'Low Speed') {
    return `${state.gpsMessage} ${state.message || 'Attitude remains visible; drift may grow.'}`;
  }
  if (state.crossed) return state.message || 'Hold straight and level, then recalibrate.';
  if (state.attitude?.gpsAiding) return 'Calibrated · GPS attitude aiding active';
  if (state.attitude?.magneticFusion.active) return 'Calibrated · relative magnetic aiding active';
  return state.trueHeading ? 'Calibrated · waiting for GPS attitude aiding' : 'Calibrated · relative attitude';
}

export function AhrsTool({ layer, route, revision, visible = true }: {
  layer: AhrsLayer; route?: Pick<RoutePlan, 'legs'>; revision?: string; visible?: boolean;
}) {
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const visibility = () => {
      setPageVisible(!document.hidden);
      layer.recorder.record('document-visibility', performance.now() / 1000, { hidden: document.hidden });
      if (document.hidden) void layer.recorder.flush();
    };
    const pagehide = () => { void layer.recorder.flush(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    visibility();
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
    };
  }, [layer]);
  const active = visible && pageVisible;
  const magneticModel = useMagneticModel(revision, active);
  useEffect(() => layer.setVisible(active), [layer, active]);
  const source = useMemo(() => ({ getSnapshot: layer.getSnapshot,
    subscribe: (listener: () => void) => active ? layer.subscribe(listener) : () => {},
  }), [layer, active]);
  const state = useLayerSnapshot(source);
  const [mount, setMount] = useState<Mount>('upright');
  const [heading, setHeading] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fullScreen, setFullScreen] = usePersistentState('ahrs-fullscreen', false, isBoolean);
  const expanded = fullScreen && visible;
  const fullScreenButton = useRef<HTMLButtonElement>(null);
  const testDisplay = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!active) setTesting(false); }, [active]);
  useEffect(() => { if (testing) testDisplay.current?.scrollIntoView({ block: 'start' }); }, [testing]);
  useEffect(() => () => layer.stop(), [layer]);
  const setup = confirming || state.phase === 'idle' || state.phase === 'error';
  const calibrating = state.phase === 'calibrating' || state.phase === 'requesting';
  const keepAwake = active && (testing || calibrating || state.phase === 'ready');
  useEffect(() => {
    if (!keepAwake || !navigator.wakeLock) return;
    let cancelled = false, lock: WakeLockSentinel | undefined;
    void navigator.wakeLock.request('screen').then(acquired => {
      // Stowing or stopping can happen before the browser grants the request.
      if (cancelled) void acquired.release().catch(() => {});
      else lock = acquired;
    }).catch(() => {}); // Unsupported policy or power-saving must not interrupt AHRS.
    return () => {
      cancelled = true;
      void lock?.release().catch(() => {});
    };
  }, [keepAwake]);
  const calibrationPaused = state.phase === 'calibrating' && state.calibrationReason === 'imu-stale';
  const calibrationWaiting = state.phase === 'calibrating' &&
    !['collecting-imu', 'imu-stale', 'pose-changed'].includes(state.calibrationReason);
  const calibrationProgress = `${Math.floor(state.progress * 10)} / 10 s`;
  return <AhrsWindow expanded={expanded} onExit={() => setFullScreen(false)} button={fullScreenButton}>
    <section className="ahrs-tool" aria-label="AHRS toolbox">
      <header className="ahrs-heading"><h3>Attitude</h3>
        <div className="ahrs-heading-actions">
          <AhrsRecorderControl layer={layer} visible={active} onStart={() => {
            setTesting(false);
            return layer.startRecording({ userAgent: navigator.userAgent,
              appScript: document.querySelector<HTMLScriptElement>('script[type="module"]')?.src ?? null });
          }} />
          <AhrsFullScreenButton expanded={expanded} button={fullScreenButton} onClick={() => setFullScreen(value => !value)} />
        </div>
        <span className={`ahrs-gps${testing ? ' is-test' : state.gpsUsable ? ' is-live' : ''}`}><i />{testing ? 'TEST' : state.gpsLive ? state.gpsUsable ? 'GPS live' : 'GPS · low speed' : 'No GPS'}</span>
      </header>
      <div className="ahrs-content panel-scroll">
        <div hidden={testing} className="ahrs-display">
          <div className="ahrs-primary-display">
            <AhrsInstruments layer={layer} active={active && !testing} />
            {state.phase === 'ready' && <AhrsDiagnostics layer={layer} active={active && !testing} />}
          </div>
          <Hsi state={state} route={route} active={active && !testing} magneticModel={magneticModel} />
        </div>
        {testing && <div ref={testDisplay}><InstrumentTest active={active} magneticModel={magneticModel} /></div>}
        {setup ? <form className="ahrs-setup" onSubmit={event => {
          event.preventDefault(); setConfirming(false); setTesting(false);
          void layer.calibrate(mount, heading.trim() === '' ? undefined : Number(heading));
        }}>
          <strong>Calibrate attitude</strong>
          <p>Secure the device in its mount and hold roughly steady and level for about 10 seconds. In flight, keep straight and level at a steady speed; small movements and cockpit vibration are okay.</p>
          <p>Calibration can finish with no GPS fix, including while stationary. Once calibrated, IMU attitude stays visible and moving beneath any red cross.</p>
          <label>Device mount<select value={mount} onChange={event => setMount(event.target.value as Mount)}>
            <option value="upright">Upright · screen facing you</option><option value="flat">Flat · top edge forward</option>
          </select></label>
          <details><summary>True heading (optional)</summary>
            <p>A known true heading initializes direction once during calibration. Without it, steady GPS motion can aid tilt; changing motion can establish heading and enable full GPS aiding.</p>
            <label>True heading · degrees<input type="number" min="0" max="359.9" step="any" inputMode="decimal"
              value={heading} onChange={event => setHeading(event.target.value)} placeholder="Relative attitude if blank" /></label>
          </details>
          {state.message && !testing && <p className="ahrs-message" role="status">{state.message}</p>}
          <button type="submit" className="ahrs-primary">Calibrate</button>
          {confirming && <button type="button" className="ahrs-secondary" onClick={() => { setConfirming(false); setTesting(false); }}>Cancel</button>}
        </form> : calibrating ? <div className="ahrs-calibration" role="status">
          <div><strong>{state.phase === 'requesting' ? 'Allow motion access' : 'Calibrating pitch, bank & gyro'}</strong>
            <span>{calibrationWaiting ? 'Waiting' : `${calibrationPaused ? 'Paused · ' : ''}${calibrationProgress}`}</span></div>
          <progress max="1" value={state.progress} aria-label="Calibration progress"
            aria-valuetext={calibrationPaused ? `Paused at ${calibrationProgress}; resumes with motion readings`
              : calibrationWaiting ? 'Waiting for acceptable sensor readings; calibration is not complete' : undefined} />
          <p>{state.message || reasons[state.calibrationReason]}</p>
          {!state.gpsUsable && <p>{state.gpsMessage} Calibration can still complete as a reference.</p>}
          {!state.gpsLive && state.phase === 'calibrating' &&
            <button type="button" className="ahrs-secondary" onClick={layer.retryGps}>Retry GPS</button>}
          <button type="button" className="ahrs-secondary" onClick={() => { setTesting(false); layer.stop(); }}>Cancel calibration</button>
        </div> : <div className="ahrs-actions">
          <p role="status">{attitudeStatus(state)}</p>
          <div><button type="button" onClick={() => setConfirming(true)}>Recalibrate</button>
            {!state.gpsLive && <button type="button" onClick={layer.retryGps}>Retry GPS</button>}
            <button type="button" onClick={() => { setTesting(false); layer.stop(); }}>Stop</button></div>
        </div>}
        <button type="button" className="ahrs-secondary ahrs-test-toggle" aria-pressed={testing} onClick={() => setTesting(value => !value)}>
          {testing ? 'Stop test' : 'Test'}
        </button>
      </div>
      <footer className="ahrs-footnote">Experimental attitude · not flight validated</footer>
    </section>
  </AhrsWindow>;
}
