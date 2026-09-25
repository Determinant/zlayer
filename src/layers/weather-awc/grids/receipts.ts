export const GRID_RETRY_MS = 60_000;
export type FrameReceipt = Readonly<{ saved?: boolean; error?: { at: number; message: string } }>;

/** File receipts are independent of decoded/display readiness. Each replacement
 * is also an inventory token, so a late check cannot overwrite a newer save. */
export class GridReceipts {
  #frames = new Map<string, FrameReceipt>();
  get frames(): ReadonlyMap<string, FrameReceipt> { return this.#frames; }

  retain(keys: readonly string[], now: number) {
    const wanted = new Set(keys);
    for (const key of this.#frames.keys()) if (!wanted.has(key)) this.#frames.delete(key);
    for (const key of keys) {
      const current = this.#frames.get(key) ?? {};
      const error = current.error;
      this.#frames.set(key, error && (now < error.at || now - error.at >= GRID_RETRY_MS)
        ? { ...(current.saved === undefined ? {} : { saved: current.saved }) } : current);
    }
  }
  loaded(key: string, saved: boolean, saving: boolean) {
    const current = this.#frames.get(key);
    if (current) this.#frames.set(key, saved || !saving ? { saved } : { ...(current.saved === undefined ? {} : { saved: current.saved }) });
  }
  saved(key: string, saved: boolean) {
    const current = this.#frames.get(key);
    if (current) this.#frames.set(key, { ...current, saved });
  }
  failed(key: string, message: string, now: number, displayed?: boolean) {
    const current = this.#frames.get(key);
    if (current) this.#frames.set(key, { ...(displayed === undefined ? current : displayed ? { saved: false } : {}), error: { at: now, message } });
  }
  clearErrors() {
    for (const [key, { saved, error }] of this.#frames) if (error) this.#frames.set(key, saved === undefined ? {} : { saved });
  }
  retry() {
    for (const [key, { saved }] of this.#frames) this.#frames.set(key, saved === true ? { saved } : {});
  }
  reconcileInventory(checks: readonly { key: string; receipt: FrameReceipt; saved: boolean }[]) {
    for (const { key, receipt, saved } of checks) {
      if (this.#frames.get(key) === receipt) this.saved(key, saved);
    }
  }
}
