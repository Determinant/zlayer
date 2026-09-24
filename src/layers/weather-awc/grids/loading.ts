import { createTaskLimiter } from '../../../core/data/task-limiter';

// All clients/products share one inflation/validation slot. Two bounded compressed
// acquisitions may wait independently, so one cold response leaves room for a ready one.
// Controllers own foreground priority/cancellation; core owns both admissions.
export const loadForecast = createTaskLimiter(1);
export const acquireForecast = createTaskLimiter(2);
// A wind interpolation keeps its boundary levels while inputs transfer. Give it
// separate admission so a network wait cannot occupy scalar acquisition slots.
export const interpolateWind = createTaskLimiter(1);
