import type { LayerEvents } from '../../core/layers/events';
import type { ProcedureSelection } from './data';

export type PlatesApi = {
  open(selection: ProcedureSelection): void;
  contextAction(point: { x: number; y: number }): boolean;
  readonly opened: LayerEvents<ProcedureSelection>;
};
