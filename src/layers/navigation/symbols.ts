import type { ExpressionSpecification } from 'maplibre-gl';
import { NAVAID_TYPE_ALIASES } from '@zlayer/domain';

export const NAVIGATION_ICON_IDS = [
  'vfr-diamond', 'fix-triangle', 'fix-rnav', 'navaid-vor', 'navaid-vor-dme', 'navaid-vortac',
  'navaid-ndb', 'navaid-ndb-dme', 'navaid-dme', 'navaid-tacan', 'navaid-generic',
] as const;

type NavigationIconId = typeof NAVIGATION_ICON_IDS[number];

// NASR FIX_USE_CODE identifies waypoints, but RP/MR reporting points can also
// be charted as RNAV in CHARTING_REMARK. Use both fields, including on routes
// and selections, where the raw feature has no background display metadata.
export const FIX_ICON_IMAGE: ExpressionSpecification = [
  'case',
  ['any',
    ['match', ['upcase', ['coalesce', ['get', 'useCode'], '']], ['WP', 'MW', 'NRS'], true, false],
    ['in', 'RNAV', ['upcase', ['coalesce', ['get', 'chartingRemark'], '']]],
  ],
  'fix-rnav',
  'fix-triangle',
];

// The feed uses FAA names (notably VOR/DME); accept common compact spellings too.
export const NAVAID_ICON_IMAGE: ExpressionSpecification = [
  'match', ['upcase', ['coalesce', ['get', 'type'], '']],
  'VOR', 'navaid-vor',
  NAVAID_TYPE_ALIASES['VOR/DME'], 'navaid-vor-dme',
  'VORTAC', 'navaid-vortac',
  ['NDB', 'MARINE NDB'], 'navaid-ndb',
  NAVAID_TYPE_ALIASES['NDB/DME'], 'navaid-ndb-dme',
  'DME', 'navaid-dme',
  'TACAN', 'navaid-tacan',
  'navaid-generic',
];

// Standard chart geometry, following the ForeFlight Legends Guide, pp. 7–8:
// https://cloudfront.foreflight.com/docs/ff/15.9/Foreflight%20Legends%20Guide%20v15.9.pdf
// Draw at 2x resolution so the small center openings remain clear on the map.
export function createNavigationIcon(id: NavigationIconId): ImageData {
  const canvas = document.createElement('canvas');
  // Keep the existing VFR marker's image bounds (and collision footprint).
  const size = id === 'vfr-diamond' ? 32 : 64;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  context.scale(2, 2);
  context.translate(size / 4, size / 4);
  context.strokeStyle = '#07111f';
  context.fillStyle = '#b9b8ce';
  context.lineWidth = id === 'vfr-diamond' ? 1.5 : 1.4;
  context.lineJoin = 'miter';

  switch (id) {
    case 'vfr-diamond':
      context.fillStyle = '#ffbd66';
      polygon(context, [[0, -5], [5, 0], [0, 5], [-5, 0]]);
      break;
    case 'fix-triangle':
      context.fillStyle = '#42cde3';
      polygon(context, [[0, -8.5], [8, 6], [-8, 6]]);
      break;
    case 'fix-rnav':
      context.fillStyle = '#42cde3';
      polygon(context, [[0, -10], [2.5, -2.5], [10, 0], [2.5, 2.5],
        [0, 10], [-2.5, 2.5], [-10, 0], [-2.5, -2.5]]);
      break;
    case 'navaid-vor':
      hexagon(context, 10);
      center(context, true);
      break;
    case 'navaid-vor-dme':
      dmeFrame(context);
      hexagon(context, 10);
      center(context, true);
      break;
    case 'navaid-vortac':
    case 'navaid-tacan':
      // A flat-topped hexagon with rectangular tabs on alternating sides.
      // The two upper tabs and the bottom tab give the standard VORTAC outline.
      polygon(context, [
        [-4, -6.93], [4, -6.93], [7.9, -9.18], [11.9, -2.25],
        [8, 0], [4, 6.93], [4, 11.43], [-4, 11.43],
        [-4, 6.93], [-8, 0], [-11.9, -2.25], [-7.9, -9.18],
      ]);
      if (id === 'navaid-vortac') center(context, true);
      break;
    case 'navaid-ndb':
    case 'navaid-ndb-dme':
      circle(context, 10);
      if (id === 'navaid-ndb-dme') {
        context.beginPath();
        context.rect(-6.5, -6.5, 13, 13);
        context.stroke();
      }
      center(context, false);
      break;
    case 'navaid-dme':
      dmeFrame(context);
      break;
    case 'navaid-generic':
      // Do not misidentify VOT, marker beacons, or an unknown type as a VOR.
      polygon(context, [[0, -7], [7, 0], [0, 7], [-7, 0]]);
      break;
  }
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function polygon(context: CanvasRenderingContext2D, points: readonly (readonly [number, number])[]): void {
  context.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.closePath();
  context.fill();
  context.stroke();
}

function hexagon(context: CanvasRenderingContext2D, radius: number): void {
  const height = radius * Math.sqrt(3) / 2;
  polygon(context, [
    [-radius / 2, -height], [radius / 2, -height], [radius, 0],
    [radius / 2, height], [-radius / 2, height], [-radius, 0],
  ]);
}

function circle(context: CanvasRenderingContext2D, radius: number): void {
  context.beginPath();
  context.arc(0, 0, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
}

function dmeFrame(context: CanvasRenderingContext2D): void {
  context.save();
  context.fillStyle = '#f1f5f6';
  polygon(context, [[-11, -11], [11, -11], [11, 11], [-11, 11]]);
  context.restore();
}

function center(context: CanvasRenderingContext2D, hexagonal: boolean): void {
  context.save();
  context.fillStyle = '#f1f5f6';
  if (hexagonal) hexagon(context, 3.5);
  else circle(context, 3);
  context.restore();
}
