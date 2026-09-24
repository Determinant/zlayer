import { useLayerSnapshot } from '../../../core/layers/use-snapshot';
import { formatAge, formatTimestamp } from '../../../core/format/time';
import type { WeatherController } from '../controller';
import { currentRadar, radarTimes } from './time';
import { RADAR_COLORS } from './palette';
export function RadarControls({ controller }: { controller: WeatherController }) {
  const state = useLayerSnapshot(controller), record = state.radar, enabled = state.preferences.awcRadar;
  const files = currentRadar(record.snapshot, state.selectedTime, state.now), national = files.find(f => f.site === 'CONUS');
  const times = radarTimes(record.snapshot, state.now), historical = state.selectedTime !== null && state.selectedTime <= state.now;
  const motion = state.radarMotion, motionDisplay = state.radarMotionDisplay, motionEnabled = state.preferences.awcRadarMotion;
  return <div className="awc-radar-controls">
    <button type="button" role="switch" aria-checked={enabled}
      className="ui-button ui-button--quiet ui-button--slim awc-radar-toggle" onClick={() => controller.change({ awcRadar: !enabled })}>
      <span>Radar mosaic</span><span className="switch" aria-hidden="true"><i /></span>
    </button>
    <small>NEXRAD composite + terminal Doppler detail. Rewind the timeline for recent scans; Now follows live updates.</small>
    {enabled && <>
      <button type="button" role="switch" aria-checked={motionEnabled}
        className="ui-button ui-button--quiet ui-button--slim awc-radar-toggle" onClick={() => controller.change({ awcRadarMotion: !motionEnabled })}>
        <span>Storm motion</span><span className="switch" aria-hidden="true"><i /></span>
      </button>
      {motionEnabled && <div className="awc-product-status" role="status">
        <small>NOAA cell tracks · Arrows show projected movement; dots mark forecast positions.</small>
        <span>{motionDisplay.loading ? 'Drawing storm motion…' : motionDisplay.stations
          ? `${motionDisplay.cells} cell tracks · ${motionDisplay.stations} radar stations`
          : motion.loading ? 'Loading storm motion…' : 'No storm motion available for this radar time'}</span>
        {motionDisplay.oldest !== undefined && motionDisplay.newest !== undefined && <small>Scans {formatTimestamp(motionDisplay.oldest)} – {formatTimestamp(motionDisplay.newest)}</small>}
        {(motion.error || motionDisplay.error) && <small className="awc-error">{motion.error || motionDisplay.error}</small>}
        {motion.snapshot && state.now - motion.snapshot.checkedAt > 5 * 60_000 && <small className="awc-error">Saved storm motion · Source check is out of date.</small>}
        {!!motion.snapshot?.unavailable.length && <small>{motion.snapshot.unavailable.length} tracking sources unavailable. Coverage may be incomplete.</small>}
      </div>}
      <div className="awc-radar-frame" role="status">
        <strong>{historical ? 'Radar history' : state.selectedTime === null ? 'Current radar' : 'Radar'}</strong>
        <span>{national ? `Composite ${formatTimestamp(national.observedAt)}`
          : state.selectedTime !== null && state.selectedTime > state.now ? 'No radar forecast. Choose Now or an earlier time.'
          : record.loading ? 'Loading radar…' : historical ? 'No radar scan for this time' : 'No current national radar'}</span>
        {national && <small>{historical ? `${formatAge(Math.max(0, state.selectedTime! - national.observedAt))} before selected time`
          : `${formatAge(Math.max(0, state.now - national.observedAt))} old`} · {files.length - 1} terminal scans available</small>}
        {times.length > 1 && <small>History {formatTimestamp(times[0]!)} – {formatTimestamp(times.at(-1)!)}</small>}
        {state.radarDisplay.loading && <small>Drawing radar…</small>}
        {state.radarDisplay.sites.length > 0 && <small>Shown: {state.radarDisplay.sites.join(', ')}</small>}
      </div>
      {(record.error || state.radarDisplay.error) && <div className="awc-error" role="status">{record.error || state.radarDisplay.error}</div>}
      {record.snapshot && state.now - record.snapshot.checkedAt > 3 * 60_000 && <div className="awc-error">Saved radar · Source check is out of date.</div>}
      {!!record.snapshot?.unavailable.length && <small className="awc-error">{record.snapshot.unavailable.length} sources could not refresh. Available scans retain their observation times.</small>}
      <button type="button" className="ui-button ui-button--quiet ui-button--slim" onClick={() => controller.retryRadar()}>Refresh radar</button>
      <div className="awc-radar-legend" aria-label="Radar reflectivity in dBZ">{RADAR_COLORS.map((color, i) => <span key={color}><i style={{ backgroundColor: color }} />{5 + i * 10}</span>)}<small>dBZ</small></div>
      <small>Terminal detail appears as you zoom in. Stronger echoes draw above weaker echoes.</small>
      <details className="awc-source-status"><summary>Radar sources &amp; scan times</summary>
        <div className="awc-product-status"><strong>NOAA MRMS / TDWR</strong>
          <small>The national composite includes returns aloft; terminal scans show the lowest tilt. Scans must be less than 15 minutes before the displayed time.</small>
          <small>Up to two hours of history, sampled about every five minutes. National history fills in from NOAA; terminal history builds as scans arrive.</small>
          <small>Storm motion uses NEXRAD Storm Tracking Information. Projected cell positions are guidance, not a radar forecast or wind velocity. Tracking can miss cells and becomes less reliable when storms merge or change direction. Motion history builds as scans arrive.</small>
        </div>
        {(files.length ? files : record.snapshot?.files ?? []).map(file => <div className="awc-product-status" key={file.site}>
          <strong>{file.site === 'CONUS' ? 'National composite' : file.site}</strong><span>{formatTimestamp(file.observedAt)}</span>
          <small>{file.site === 'CONUS' ? 'MRMS · 1 km grid' : 'TDWR · 150 m range gates'}</small>
        </div>)}
        <a href="https://www.weather.gov/radarfaq" target="_blank" rel="noreferrer">NOAA radar products</a>
      </details>
    </>}
  </div>;
}
