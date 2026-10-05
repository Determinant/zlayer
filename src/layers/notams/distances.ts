export type NotamDistances = { kind: 'distances'; runway: string; values: { label: string; value: string }[] };

/** Only explicitly labeled declared distances, with every field and unit accounted for. */
export function declaredDistances(source: string): NotamDistances | undefined {
  if (source.length > 2048) return undefined;
  const text = source.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  const heading = /^RWY ((?:0?[1-9]|[12]\d|3[0-6])[LRC]?) DECLARED DIST:\s*/.exec(text);
  if (!heading) return undefined;
  const rest = text.slice(heading[0].length);
  if (!/^(?:(?:TORA|TODA|ASDA|LDA) \d+(?:\.\d+)?\s*FT\s*)+$/.test(rest)) return undefined;
  const values = [...rest.matchAll(/(TORA|TODA|ASDA|LDA) (\d+(?:\.\d+)?)\s*FT/g)]
    .map(match => ({ label: match[1]!, value: `${match[2]} FT` }));
  if (new Set(values.map(v => v.label)).size !== values.length) return undefined;
  return { kind: 'distances', runway: heading[1]!, values };
}
