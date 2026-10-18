/** Whole-field parsing: unsupported suffixes retain the field as reported, rather
 * than publishing the successfully parsed prefix as a complete observation. */
export class Cursor {
  readonly tokens: string[];
  position = 0;
  constructor(text: string) { this.tokens = text.match(/[A-Z]+|\d+|[^\s]/g) ?? []; }
  peek(offset = 0) { return this.tokens[this.position + offset]; }
  take(token: string) { if (this.peek() !== token) return false; this.position++; return true; }
  phrase(...tokens: string[]) {
    if (!tokens.every((token, index) => this.peek(index) === token)) return false;
    this.position += tokens.length; return true;
  }
  get done() { return this.position === this.tokens.length; }
}
/** A recognized field may explicitly say no observation was supplied. Notes
 * preserve that evidence without adding it to the hazard filter's observations. */
export type Condition = { values: string[]; notes?: string[] };
export const numeric = (token?: string): token is string => token !== undefined && /^\d{1,3}$/.test(token);
export const excerpt = (text: string) => text.length <= 2000 ? text : `${text.slice(0, 1950)} [Source field excerpt]`;
export const feet = (token: string) => Number(token) * 100;

export function range(cursor: Cursor, values: Record<string, string>): string | undefined {
  const first = values[cursor.peek() ?? ''];
  if (!first) return;
  cursor.position++;
  if (cursor.peek() === '-' && values[cursor.peek(1) ?? '']) {
    cursor.position += 2;
    return `${first}-${values[cursor.tokens[cursor.position - 1]!]}`;
  }
  return first;
}
