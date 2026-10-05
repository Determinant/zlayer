export type NotamMinimumRow = { values: { label: string; value: string }[]; categories?: string };
export type NotamMinima = { kind: 'minima'; scope: string; context?: string; rows: NotamMinimumRow[]; condition?: string };
export type NotamMinimaGroup = { kind: 'minima-group'; entries: NotamMinima[] };

const runway = '(?:0?[1-9]|[12]\\d|3[0-6])[LRC]?';
const scopePattern = new RegExp(`^([*#]?(?:LNAV/VNAV|LNAV|LPV|LP|GLS|RNP (?:\\d+(?:\\.\\d+)?|\\.\\d+)|` +
  `(?:S|H)- ?(?:ILS|LOC)(?: (?:RWY )?${runway})?|S-${runway}(?: LOC)?|CIRCLING|SIDESTEP:? (?:RWY )?${runway})[*#]?)(?=\\s|:)[: ]*`);
const categories = '(ALL CATS?|CATS? [A-E](?:/[A-E])*)';
const visibility = '(?:\\d+-\\d+/\\d+|\\d+ \\d+/\\d+|\\d+/\\d+|\\d+(?:\\.\\d+)?)(?: (?:SM|MILES?))?';
const fieldPattern = new RegExp(`^(?:${categories} )?(MDA|DA|HAT|HAA|HAS|VISIBILITY|VIS|RVR)([*#]?)\\s*` +
  `(?:${categories} )?(RVR )?(${visibility}|NA)(?:(?:\\s*/\\s*| +)(HAT|HAA|HAS)\\s*(\\d+))?(?: ${categories})?$`);
const implicitVisibility = new RegExp(`^${categories} (${visibility})$`);
const categoryLabel = (text: string) => /^ALL CATS?$/.test(text) ? 'All categories' : text.replace(/^CATS /, 'CAT ');

function minimumRow(text: string, previous?: NotamMinimumRow): NotamMinimumRow | undefined {
  const match = fieldPattern.exec(text);
  if (!match) {
    // Only an explicit visibility value establishes shorthand in the next category.
    // Never assume a missing RVR label, altitude type, or unit.
    const implicit = implicitVisibility.exec(text);
    if (implicit && previous?.values.length === 1 && previous.values[0]!.label === 'Visibility' &&
      !previous.values[0]!.value.startsWith('RVR ')) {
      return { categories: categoryLabel(implicit[1]!), values: [{ label: 'Visibility', value: implicit[2]! }] };
    }
    return undefined;
  }
  const [, before, metric, marker, middle, rvr, value, height, heightValue, after] = match;
  const scopes = [before, middle, after].filter((v): v is string => !!v);
  if (scopes.length > 1 || (rvr && !['VIS', 'VISIBILITY'].includes(metric!)) ||
    (height && !['MDA', 'DA'].includes(metric!)) ||
    (value === 'NA' && (height || rvr)) ||
    (!['VIS', 'VISIBILITY'].includes(metric!) && !/^(?:\d+(?:\.\d+)?|NA)$/.test(value!))) return undefined;
  const label = ['VIS', 'VISIBILITY'].includes(metric!) ? 'Visibility' : metric!;
  return { values: [{ label: `${label}${marker}`, value: `${rvr ?? ''}${value}` },
    ...(height ? [{ label: height, value: heightValue! }] : [])],
    ...(scopes[0] ? { categories: categoryLabel(scopes[0]) } : {}) };
}

/** Whole-clause grammar: do not lift numbers out of notes, exceptions or unknown prose. */
export function approachMinima(source: string): NotamMinima | undefined {
  if (source.length > 2048) return undefined;
  let text = source.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  const fix = /^([A-Z0-9]+ FIX MINIMUMS(?: \([A-Z0-9 /-]+\))?):?\s+/.exec(text);
  if (fix) text = text.slice(fix[0].length);
  const scope = scopePattern.exec(text);
  if (scope) text = text.slice(scope[0].length);
  // A standalone amendment retains source order; no procedure/category
  // or units are borrowed from a preceding line of minima.
  if (!scope && !/^(?:(?:ALL CATS?|CATS? [A-E](?:\/[A-E])*) )?(?:MDA|DA|HAT|HAA|HAS|VISIBILITY|VIS|RVR)\b/.test(text)) return undefined;
  const condition = /(?:,?\s+)((?:UNLESS|EXCEPT WHEN)\b.+)$/.exec(text);
  if (condition) text = text.slice(0, condition.index);
  // Explicit adjacent fields with the publisher's value-before-RVR spelling.
  // The final category scope applies to this complete row, not a later clause.
  const adjacent = new RegExp(`^(DA|MDA) (\\d+)\\s*/\\s*(HAT|HAA|HAS) (\\d+) VIS(?:IBILITY)? (\\d+) RVR(?: ${categories})?$`).exec(text);
  if (adjacent && scope && !fix && !condition) return { kind: 'minima', scope: scope[1]!, rows: [{
    values: [{ label: adjacent[1]!, value: adjacent[2]! }, { label: adjacent[3]!, value: adjacent[4]! },
      { label: 'Visibility', value: `RVR ${adjacent[5]}` }],
    ...(adjacent[6] ? { categories: categoryLabel(adjacent[6]) } : {}),
  }] };
  // Explicit field order supplies the meaning of every slash-separated value.
  // Radio-altitude shorthand and missing labels still remain unstructured.
  const triplet = new RegExp(`^(DA|MDA)/RVR/(HAT|HAA|HAS)(?: ${categories})? (\\d+)/(\\d+)/(\\d+)$`).exec(text);
  if (triplet && scope) return { kind: 'minima', scope: scope[1]!, rows: [{
    values: [{ label: triplet[1]!, value: triplet[4]! }, { label: 'RVR', value: triplet[5]! }, { label: triplet[2]!, value: triplet[6]! }],
    ...(triplet[3] ? { categories: categoryLabel(triplet[3]) } : {}),
  }], ...(fix ? { context: fix[1]!.replace('FIX MINIMUMS', 'fix minimums') } : {}),
    ...(condition ? { condition: condition[1]! } : {}) };
  const segments = text.split(/\s*,\s*/);
  if (segments.length > 16) return undefined;
  const rows: NotamMinimumRow[] = [];
  for (let segment of segments) {
    if (scope && segment.startsWith(`${scope[1]} `)) segment = segment.slice(scope[1]!.length + 1);
    // Some publishers put a comma before the first row's category qualifier.
    if (/^ALL CATS?$/.test(segment) && rows.length === 1 && !rows[0]!.categories) {
      rows[0]!.categories = categoryLabel(segment); continue;
    }
    const row = minimumRow(segment, rows.at(-1));
    if (!row) return undefined;
    rows.push(row);
  }
  if (!rows.length) return undefined;
  const unscoped = rows.every(row => row.values.every(value => ['Visibility', 'RVR'].includes(value.label))) ? 'Visibility' : 'Minimums';
  return { kind: 'minima', scope: scope?.[1]?.replace(/^CIRCLING$/, 'Circling').replace(/^SIDESTEP:? (?:RWY )?/, 'Sidestep runway ') ?? unscoped, rows,
    ...(fix ? { context: fix[1]!.replace('FIX MINIMUMS', 'fix minimums') } : {}),
    ...(condition ? { condition: condition[1]!.replace(/^UNLESS /, 'Unless ').replace(/^EXCEPT WHEN /, 'Except when ') } : {}) };
}

/** Multiple explicitly named minima on one line; the whole group must succeed. */
export function approachMinimaGroup(source: string): NotamMinima | NotamMinimaGroup | undefined {
  const single = approachMinima(source);
  if (single) return single;
  if (source.length > 2048 || /\b(?:UNLESS|EXCEPT|NOTE|IF|WHEN|DISREGARD|DELETE|CHANGE)\b/.test(source)) return undefined;
  const parts = source.replace(/\s+/g, ' ').trim().split(/, (?=(?:[*#]?(?:LNAV|LPV|LP|GLS|RNP|S-|H-|CIRCLING|SIDESTEP))\b)/);
  if (parts.length < 2 || parts.length > 16) return undefined;
  const entries = parts.map(approachMinima);
  return entries.every((entry): entry is NotamMinima => !!entry) ? { kind: 'minima-group', entries } : undefined;
}
