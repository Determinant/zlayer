import { offlineRecordKeys } from './core/storage/database';

export function isResetAdvisory(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

/** One receipt per data-format change, independent of app release hashes. */
export class ResetAdvisories {
  private handled = new Set<string>();

  async claim(id: string): Promise<boolean> {
    const claim = () => {
      if (this.handled.has(id)) return false;
      this.handled.add(id);
      try {
        const key = `zlayer-reset-advisory:${id}`;
        if (localStorage.getItem(key) === '1') return false;
        localStorage.setItem(key, '1');
      } catch { /* Denied storage still permits one advisory in this page session. */ }
      return true;
    };
    // Claim atomically across windows; never hold the lock while a dialog is open.
    if (typeof navigator !== 'undefined' && navigator.locks) {
      try { return await navigator.locks.request('zlayer-reset-advisory', claim); }
      catch { /* Some browsers expose Web Locks but deny access to them. */ }
    }
    return claim();
  }

  async startup(id: string | undefined, hasData: () => Promise<boolean> = hasLocalData): Promise<boolean> {
    if (!id) return false;
    const existing = await hasData();
    const first = await this.claim(id);
    // New installs start with the current format and silently consume its advisory.
    return existing && first;
  }
}

async function hasLocalData(): Promise<boolean> {
  try {
    const names = await caches.keys();
    if (names.some(name => /^zlayers-(?:data|chart|procedures|file-receipts)-/.test(name))) return true;
  } catch { /* Saved regional metadata may still be available. */ }
  try { return (await offlineRecordKeys('region:')).length > 0; }
  catch { return false; } // An optional advisory must not block workspace startup.
}

export const resetAdvisories = new ResetAdvisories();
