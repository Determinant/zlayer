/** Header-only checks must release the cached file stream, even for bad receipts.
 * Do not wait for cancellation: a cloned/teed body's other consumer may still be active. */
export function discardResponseBody(response: Response | undefined): void {
  if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
}
