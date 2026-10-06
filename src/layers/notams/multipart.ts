export type SourceSpan = { start: number; end: number };
export type NotamPart = SourceSpan & { opening?: SourceSpan; closing?: SourceSpan };

/** Prove transport order before any consumer interprets a multipart body.
 * NMS can omit opening markers; every part still needs its own ordered ending.
 * Positions always address the original source, including publisher whitespace. */
export function notamParts(source: string): NotamPart[] | undefined {
  if (source.length > 64 * 1024) return;
  const tokens = [...source.matchAll(/\b(END\s+)?PART\s+(\S+)\s+OF\s+(\S+)/gi)];
  if (!tokens.length) return [{ start: 0, end: source.length }];
  if (tokens.length > 198) return;
  const parts: NotamPart[] = [];
  let start = 0, total: number | undefined, opening: SourceSpan | undefined;
  for (const token of tokens) {
    if (!/^\d+$/.test(token[2]!) || !/^\d+$/.test(token[3]!)) return;
    const number = Number(token[2]), count = Number(token[3]);
    if (count < 1 || count > 99 || number !== parts.length + 1 || total !== undefined && count !== total) return;
    total = count;
    const span = { start: token.index, end: token.index + token[0].length };
    if (!token[1]) {
      // An opening may follow only a local-format envelope, never body prose.
      if (opening || !/^\s*(?:![A-Z0-9]+\s+\d+\/\d+\s+[A-Z0-9]+\s+)?$/i.test(source.slice(start, token.index))) return;
      opening = span;
    } else {
      if (number > count || !source.slice(opening?.end ?? start, token.index).trim()) return;
      parts.push({ start, end: token.index, ...(opening ? { opening } : {}), closing: span });
      start = span.end; opening = undefined;
    }
  }
  if (opening || parts.length !== total || source.slice(start).trim()) return;
  return parts;
}

/** Mask only proven transport markers; geometry spans must not drift after assembly. */
export function maskNotamParts(source: string, parts: readonly NotamPart[]): string {
  const spans = parts.flatMap(part => [part.opening, part.closing].filter((s): s is SourceSpan => !!s));
  let masked = source;
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    masked = masked.slice(0, span.start) + ' '.repeat(span.end - span.start) + masked.slice(span.end);
  }
  return masked;
}
