export function mapErrorMessage(event: { error: { name?: string; message: string }; sourceId?: string }): string | undefined {
  if (event.error.name === 'AbortError') return undefined;
  return `${event.sourceId ?? 'Map'}: ${event.error.message}`;
}
