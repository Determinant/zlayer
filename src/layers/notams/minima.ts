import { minimumRow } from './minima-row';

export type NotamMinimumRow = { values: { label: string; value: string }[]; categories?: string };
export type NotamMinima = { kind: 'minima'; scope: string; context?: string; rows: NotamMinimumRow[]; condition?: string };
export type NotamMinimaGroup = { kind: 'minima-group'; entries: NotamMinima[] };

const runway = '(?:0?[1-9]|[12]\\d|3[0-6])[LRC]?';
const scopePattern = new RegExp(`^([*#]?(?:LNAV/VNAV|LNAV|LPV AND LNAV/VNAV|LPV|LP|GLS|RNP (?:\\d+(?:\\.\\d+)?|\\.\\d+)|` +
  `(?:S|H)- ?(?:ILS|LOC)(?: (?:RWY )?${runway})?(?: (?:SA )?CAT I{1,3})?|ILS|LOC|S-${runway}(?: LOC)?|CIRCLING|SIDESTEP:? (?:RWY )?${runway})[*#]?)(?=\\s|:)[: ]*`);
const categories = '(ALL CATS?|CATS? [A-E](?:(?:/| AND )[A-E])*)';
const categoryLabel = (text: string) => /^ALL CATS?$/.test(text) ? 'All categories' : text.replace(/^CATS /, 'CAT ');

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
  if (!scope && !new RegExp(`^(?:${categories} )?(?:MDA|DA|RA|HAT|HAA|HAS|VISIBILITY|VIS|RVR|MINIMUMS)\\b`).test(text)) return undefined;
  const condition = /(?:,?\s+)((?:UNLESS|EXCEPT WHEN)\b.+)$/.exec(text);
  if (condition) text = text.slice(0, condition.index);
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
  const parts = source.trim().split(/(?:[,;]\s+|\r?\n\s*)(?=[*#]?(?:LNAV|LPV|LP|GLS|ILS|LOC|RNP|S-|H-|CIRCLING|SIDESTEP)\b)/);
  if (parts.length < 2 || parts.length > 16) return undefined;
  const entries = parts.map(approachMinima);
  return entries.every((entry): entry is NotamMinima => !!entry) ? { kind: 'minima-group', entries } : undefined;
}
