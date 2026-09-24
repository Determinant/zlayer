import type { LayerEvents } from '../../core/layers/events';
import type { ProcedureSelection } from './data';
import type { MapContextAction } from '../../core/map/selection';

export type PlatesApi = {
  open(selection: ProcedureSelection): void;
  contextActions(point: { x: number; y: number }): MapContextAction[];
  readonly opened: LayerEvents<ProcedureSelection>;
};
