import type { ComponentProps } from 'react';
import { usePersistentRecord } from './use-persistent-state';
import { isBoolean } from '../storage/ui-state';
import { uiRecord } from '../storage/record';
import type { PluginStorage } from '../storage/plugin-storage';

export function PersistentDetails({ storageKey, storage, ...props }: ComponentProps<'details'> & { storageKey: string; storage?: PluginStorage }) {
  const [open, setOpen] = usePersistentRecord(storage ? storage.ui(storageKey, false, isBoolean) : uiRecord(storageKey, false, isBoolean));
  return <details {...props} open={open} onToggle={event => setOpen(event.currentTarget.open)} />;
}
