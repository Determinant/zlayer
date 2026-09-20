import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { readUiState, writeUiState } from '../storage/ui-state';

/** Save in the action itself, including a close immediately followed by reload. */
export function usePersistentState<T>(key: string, fallback: T, valid: (value: unknown) => value is T) {
  const [state, setState] = useState(() => ({ key, value: readUiState(key, fallback, valid) }));
  const current = useRef(state);
  if (current.current.key !== key) {
    current.current = { key, value: readUiState(key, fallback, valid) };
  }
  const update = useMemo<Dispatch<SetStateAction<T>>>(() => next => {
    // Ignore callbacks retained by a panel whose storage identity has changed.
    if (current.current.key !== key) return;
    const value = typeof next === 'function' ? (next as (previous: T) => T)(current.current.value) : next;
    current.current = { key, value };
    writeUiState(key, value);
    setState(current.current);
  }, [key]);
  return [current.current.value, update] as const;
}
