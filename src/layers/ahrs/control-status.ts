import type { AhrsSnapshot } from './layer';

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
  return state.trueHeading ? 'Calibrated · waiting for GPS attitude aiding'
    : state.hsiHeading ? 'Calibrated · estimated heading' : 'Calibrated · relative attitude';
}


/** Only values rendered by the controls; instruments read their own live snapshot. */
export function ahrsControlStatus(state: AhrsSnapshot) {
  return { phase: state.phase, message: state.message, progress: state.progress,
    calibrationReason: state.calibrationReason, gpsLive: state.gpsLive,
    gpsUsable: state.gpsUsable, gpsMessage: state.gpsMessage, attitudeMessage: attitudeStatus(state) };
}
