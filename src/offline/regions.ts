import type { Bounds } from '@zlayer/contracts';

export type OfflineRegion = {
  id: string;
  code: string;
  title: string;
  bounds: Bounds[];
};

// Census 2024 1:500,000 state/territory envelopes, rounded OUTWARD to 0.01°.
// Alaska is split at the date line; a single envelope would select most of Earth.
// These conservative rectangles also include some neighboring chart coverage.
// Source and derivation: docs/offline-storage.md#geographic-regions
const definitions: Array<[string, string, Bounds[]]> = [
  ['AL', 'Alabama', [[-88.48, 30.22, -84.88, 35.01]]],
  ['AK', 'Alaska', [[-179.15, 51.21, -129.97, 71.39], [172.46, 51.35, 179.78, 53.02]]],
  ['AS', 'American Samoa', [[-171.09, -14.55, -168.14, -11.04]]],
  ['AZ', 'Arizona', [[-114.82, 31.33, -109.04, 37.01]]],
  ['AR', 'Arkansas', [[-94.62, 33, -89.64, 36.5]]],
  ['CA', 'California', [[-124.41, 32.53, -114.13, 42.01]]],
  ['CO', 'Colorado', [[-109.07, 36.99, -102.04, 41.01]]],
  ['CT', 'Connecticut', [[-73.73, 40.98, -71.78, 42.06]]],
  ['DE', 'Delaware', [[-75.79, 38.45, -75.04, 39.84]]],
  ['DC', 'District of Columbia', [[-77.12, 38.79, -76.9, 39]]],
  ['FL', 'Florida', [[-87.64, 24.52, -80.03, 31.01]]],
  ['GA', 'Georgia', [[-85.61, 30.35, -80.84, 35.01]]],
  ['GU', 'Guam', [[144.61, 13.23, 144.96, 13.66]]],
  ['HI', 'Hawaii', [[-178.34, 18.91, -154.8, 28.41]]],
  ['ID', 'Idaho', [[-117.25, 41.98, -111.04, 49.01]]],
  ['IL', 'Illinois', [[-91.52, 36.97, -87.49, 42.51]]],
  ['IN', 'Indiana', [[-88.1, 37.77, -84.78, 41.77]]],
  ['IA', 'Iowa', [[-96.64, 40.37, -90.14, 43.51]]],
  ['KS', 'Kansas', [[-102.06, 36.99, -94.58, 40.01]]],
  ['KY', 'Kentucky', [[-89.58, 36.49, -81.96, 39.15]]],
  ['LA', 'Louisiana', [[-94.05, 28.92, -88.81, 33.02]]],
  ['ME', 'Maine', [[-71.09, 42.97, -66.94, 47.46]]],
  ['MD', 'Maryland', [[-79.49, 37.91, -75.04, 39.73]]],
  ['MA', 'Massachusetts', [[-73.51, 41.23, -69.92, 42.89]]],
  ['MI', 'Michigan', [[-90.42, 41.69, -82.41, 48.24]]],
  ['MN', 'Minnesota', [[-97.24, 43.49, -89.49, 49.39]]],
  ['MS', 'Mississippi', [[-91.66, 30.17, -88.09, 35]]],
  ['MO', 'Missouri', [[-95.78, 35.99, -89.09, 40.62]]],
  ['MT', 'Montana', [[-116.05, 44.35, -104.03, 49.01]]],
  ['NE', 'Nebraska', [[-104.06, 39.99, -95.3, 43.01]]],
  ['NV', 'Nevada', [[-120.01, 35, -114.03, 42.01]]],
  ['NH', 'New Hampshire', [[-72.56, 42.69, -70.61, 45.31]]],
  ['NJ', 'New Jersey', [[-75.56, 38.92, -73.89, 41.36]]],
  ['NM', 'New Mexico', [[-109.06, 31.33, -103, 37.01]]],
  ['NY', 'New York', [[-79.77, 40.49, -71.85, 45.02]]],
  ['NC', 'North Carolina', [[-84.33, 33.84, -75.46, 36.59]]],
  ['ND', 'North Dakota', [[-104.05, 45.93, -96.55, 49.01]]],
  ['MP', 'Northern Mariana Islands', [[144.88, 14.11, 146.07, 20.56]]],
  ['OH', 'Ohio', [[-84.83, 38.4, -80.51, 41.98]]],
  ['OK', 'Oklahoma', [[-103.01, 33.61, -94.43, 37.01]]],
  ['OR', 'Oregon', [[-124.57, 41.99, -116.46, 46.3]]],
  ['PA', 'Pennsylvania', [[-80.52, 39.71, -74.68, 42.27]]],
  ['PR', 'Puerto Rico', [[-67.95, 17.88, -65.22, 18.52]]],
  ['RI', 'Rhode Island', [[-71.87, 41.14, -71.12, 42.02]]],
  ['SC', 'South Carolina', [[-83.36, 32.03, -78.54, 35.22]]],
  ['SD', 'South Dakota', [[-104.06, 42.47, -96.43, 45.95]]],
  ['TN', 'Tennessee', [[-90.32, 34.98, -81.64, 36.68]]],
  ['TX', 'Texas', [[-106.65, 25.83, -93.5, 36.51]]],
  ['UT', 'Utah', [[-114.06, 36.99, -109.04, 42.01]]],
  ['VT', 'Vermont', [[-73.44, 42.72, -71.46, 45.02]]],
  ['VI', 'Virgin Islands', [[-65.09, 17.67, -64.56, 18.42]]],
  ['VA', 'Virginia', [[-83.68, 36.54, -75.24, 39.47]]],
  ['WA', 'Washington', [[-124.77, 45.54, -116.91, 49.01]]],
  ['WV', 'West Virginia', [[-82.65, 37.2, -77.71, 40.64]]],
  ['WI', 'Wisconsin', [[-92.89, 42.49, -86.8, 47.09]]],
  ['WY', 'Wyoming', [[-111.06, 40.99, -104.05, 45.01]]],
];

export const OFFLINE_REGIONS: readonly OfflineRegion[] = definitions.map(([code, title, bounds]) => ({
  id: `us-${code}`, code, title, bounds,
}));
