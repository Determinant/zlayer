/** Retained source identities for cached snapshots and the NOAA comparison adapter. */
const NOAA_ADVISORY_ROOT = 'https://mapservices.weather.noaa.gov/vector/rest/services/aviation/awc_aviation_weather/MapServer/';
export const noaaAdvisoryUrl = (product: 'sigmet' | 'cwa') => `${NOAA_ADVISORY_ROOT}${product === 'sigmet' ? 111 : 113}/query`;
