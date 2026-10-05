import { createObstructionSymbol } from '../../core/graphics/obstruction-symbol';
import { OBSTRUCTION_COLOR } from './definitions';

export function createObstructionIcon(id: string): ImageData {
  const [, shape, group, light] = id.split('-');
  if (shape !== 'low' && shape !== 'tall' && shape !== 'wind') throw new Error('Unknown obstruction shape');
  return createObstructionSymbol({ shape, grouped: group === 'group', strobe: light === 'strobe', color: OBSTRUCTION_COLOR });
}
