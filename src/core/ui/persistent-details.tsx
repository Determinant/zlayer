import type { ComponentProps } from 'react';
import { usePersistentState } from './use-persistent-state';
import { isBoolean } from '../storage/ui-state';

export function PersistentDetails({ storageKey, ...props }: ComponentProps<'details'> & { storageKey: string }) {
  const [open, setOpen] = usePersistentState(storageKey, false, isBoolean);
  return <details {...props} open={open} onToggle={event => setOpen(event.currentTarget.open)} />;
}
