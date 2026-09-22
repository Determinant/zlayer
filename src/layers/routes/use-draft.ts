import { usePersistentRecord } from '../../core/ui/use-persistent-state';
import { routeDraftRecord } from './draft-storage';
export function useRouteDraft() { return usePersistentRecord(routeDraftRecord); }
