import { uiRecord } from '../storage/record';

export type Theme = 'dark' | 'light';
export const isTheme = (value: unknown): value is Theme => value === 'dark' || value === 'light';
export const themeRecord = uiRecord('appearance', 'dark' as Theme, isTheme);
let current: Theme = 'dark';
const listeners = new Set<() => void>();

export const getTheme = () => current;
export const subscribeTheme = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function applyTheme(theme: Theme) {
  current = theme;
  document.documentElement.dataset.theme = theme;
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas);
  for (const listener of listeners) listener();
}

/** Apply before React mounts, including welcome, startup and reset screens. */
export function observeTheme() {
  applyTheme(themeRecord.read());
  const onStorage = (event: StorageEvent) => {
    if (event.key === themeRecord.key || event.key === null) applyTheme(themeRecord.read());
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

export function setTheme(theme: Theme) {
  // Storage is optional: an unavailable write still changes this session.
  themeRecord.write(theme);
  applyTheme(theme);
}
