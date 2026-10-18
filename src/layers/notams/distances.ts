import type { NotamEvidence } from './interpretation';

export type NotamDistances = { kind: 'distances'; runway: string; values: { label: string; value: string }[]; runwaySource?: NotamEvidence };
export type DistanceContext = { source: string; offset: number };
export function displacedThresholdRunway(source: string): string | undefined {
  return /^RWY ((?:0?[1-9]|[12]\d|3[0-6])[LRC]?) THR DISPLACED \d+(?:\.\d+)?\s*FT(?: (?:MARKING NOT STD|NONPRECISION MARKING))?\.$/.exec(source.replace(/\s+/g, ' ').trim())?.[1];
}

/** Only explicitly labeled declared distances, with every field and unit accounted for. */
export function declaredDistances(source: string, previous?: DistanceContext): NotamDistances | undefined {
  if (source.length > 2048) return undefined;
  const text = source.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  const matches = [...text.matchAll(/\d+(?:\.\d+)?[LRC]?|[A-Z]+|\S/g)];
  // Only a quantity/unit pair or colon can be adjacent. A missing separator
  // must not turn a runway suffix or an unknown word into a different field.
  if (matches.some((token, i) => i > 0 && token.index === matches[i - 1]!.index + matches[i - 1]![0].length &&
    token[0] !== ':' && matches[i - 1]![0] !== ':' && !(token[0] === 'FT' && /^\d+(?:\.\d+)?$/.test(matches[i - 1]![0])))) return;
  const tokens = matches.map(token => token[0]);
  const values: NotamDistances['values'] = [];
  let at = 0, runway = '', label = '', value = '', declared = false;
  let runwaySource: NotamEvidence | undefined;
  let state: 'heading' | 'runway' | 'field' | 'value' | 'unit' = 'heading';
  const declaration = () => {
    if (declared || tokens[at++] !== 'DECLARED' || !['DIST', 'DISTANCES'].includes(tokens[at++] ?? '')) return false;
    if (tokens[at] === ':') at++;
    declared = true; return true;
  };
  // A declaration may precede or follow the runway. A self-contained runway
  // and explicitly labeled quantities need no inherited heading from another row.
  // Each field must reach its own unit before the next field can begin.
  while (at < tokens.length) {
    switch (state) {
      case 'heading':
        if (tokens[at] === 'DECLARED' && !declaration()) return;
        if (declared && tokens[at] !== 'RWY' && previous) {
          runway = displacedThresholdRunway(previous.source) ?? '';
          if (!runway) return;
          runwaySource = { start: previous.offset, end: previous.offset + previous.source.length, text: previous.source };
          state = 'field'; break;
        }
        if (tokens[at++] !== 'RWY') return;
        state = 'runway'; break;
      case 'runway':
        runway = tokens[at++]!;
        if (!/^(?:0?[1-9]|[12]\d|3[0-6])[LRC]?$/.test(runway)) return;
        if (tokens[at] === ':') at++;
        if (tokens[at] === 'DECLARED' && !declaration()) return;
        state = 'field'; break;
      case 'field':
        label = tokens[at++]!;
        if (!['TORA', 'TODA', 'ASDA', 'LDA'].includes(label) || values.some(v => v.label === label)) return;
        if (tokens[at] === ':') at++;
        state = 'value'; break;
      case 'value':
        value = tokens[at++]!;
        if (!/^\d+(?:\.\d+)?$/.test(value)) return;
        state = 'unit'; break;
      case 'unit':
        if (tokens[at++] !== 'FT') return;
        values.push({ label, value: `${value} FT` });
        state = 'field'; break;
    }
  }
  return state === 'field' && values.length ? { kind: 'distances', runway, values, ...(runwaySource ? { runwaySource } : {}) } : undefined;
}
