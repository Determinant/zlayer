import { OBSTRUCTION_COLOR } from './definitions';

// FAA Aeronautical Chart Users' Guide, 9 July 2026, p. 33.
// https://aeronav.faa.gov/user_guide/cug-complete_20260709.pdf
export function createObstructionIcon(id: string): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 72;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  context.scale(2, 2); context.translate(18, 19);
  const [, shape, group, light] = id.split('-');
  const strobe = light === 'strobe';
  const draw = (kind: string, x: number, y = 0) => {
    context.save(); context.translate(x, y);
    const path = new Path2D();
    if (kind === 'wind') {
      path.moveTo(0, -4); path.lineTo(0, 10);
      path.moveTo(-2, 10); path.lineTo(2, 10);
      for (let blade = 0; blade < 3; blade++) {
        const angle = -Math.PI / 2 + blade * Math.PI * 2 / 3;
        path.moveTo(Math.cos(angle) * 2, -4 + Math.sin(angle) * 2);
        path.lineTo(Math.cos(angle) * 8, -4 + Math.sin(angle) * 8);
      }
    } else if (kind === 'tall') {
      path.moveTo(-7, 8); path.quadraticCurveTo(-1, 2, -0.6, -12);
      path.lineTo(0.6, -12); path.quadraticCurveTo(1, 2, 7, 8);
      path.lineTo(3, 5); path.lineTo(0, 2.5); path.lineTo(-3, 5); path.closePath();
    } else { path.moveTo(-5, 7); path.lineTo(0, -4); path.lineTo(5, 7); }
    context.lineJoin = 'round'; context.lineCap = 'round';
    context.strokeStyle = '#081220'; context.lineWidth = kind === 'wind' ? 3.2 : 4.2; context.stroke(path);
    context.strokeStyle = OBSTRUCTION_COLOR; context.fillStyle = OBSTRUCTION_COLOR;
    context.lineWidth = kind === 'wind' ? 1.25 : 1.8; context.stroke(path);
    if (kind === 'tall') context.fill(path);
    context.beginPath(); context.arc(0, kind === 'wind' ? -4 : 7.5, 1.2, 0, Math.PI * 2); context.fill();
    if (strobe) {
      const y = kind === 'tall' ? -12 : kind === 'wind' ? -4 : -4;
      const rays = new Path2D();
      for (let i = 0; i < 6; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 3;
        rays.moveTo(Math.cos(angle) * 3, y + Math.sin(angle) * 3);
        rays.lineTo(Math.cos(angle) * 6.5, y + Math.sin(angle) * 6.5);
      }
      context.strokeStyle = '#081220'; context.lineWidth = 2.6; context.stroke(rays);
      context.strokeStyle = OBSTRUCTION_COLOR; context.lineWidth = 0.9; context.stroke(rays);
    }
    context.restore();
  };
  if (group === 'group') {
    // DOF gives the group's highest AGL, not the individual members' heights.
    // The mixed tall/low symbol avoids claiming that two members exceed 1000'.
    draw(shape === 'tall' ? 'low' : shape!, -4.5, shape === 'wind' ? 2 : 0);
    draw(shape!, 4.5, shape === 'wind' ? -2 : 0);
  } else draw(shape!, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}
