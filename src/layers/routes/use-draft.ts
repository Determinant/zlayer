import { usePersistentRecord } from '../../core/ui/use-persistent-state';
import { routeDraftRecord } from './persistent-draft';
export function useRouteDraft() { return usePersistentRecord(routeDraftRecord); }
