import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { readUiState, writeUiState } from '../storage/ui-state';

/** Save in the action itself, including a close immediately followed by reload. */
export function usePersistentState<T>(key: string, fallback: T, valid: (value: unknown) => value is T) {
  return useStoredState(key, () => readUiState(key, fallback, valid), value => writeUiState(key, value));
}

/** The same action-time lifecycle for owners with an existing storage format. */
export function useStoredState<T>(key: string, read: () => T, write: (value: T) => void) {
  const [state, setState] = useState(() => ({ key, value: read() }));
  const current = useRef(state);
  const writer = useRef(write);
  writer.current = write;
  if (current.current.key !== key) {
    current.current = { key, value: read() };
  }
  const update = useMemo<Dispatch<SetStateAction<T>>>(() => next => {
    // Ignore callbacks retained by a panel whose storage identity has changed.
    if (current.current.key !== key) return;
    const value = typeof next === 'function' ? (next as (previous: T) => T)(current.current.value) : next;
    current.current = { key, value };
    writer.current(value);
    setState(current.current);
  }, [key]);
  return [current.current.value, update] as const;
}
