type Climb = { gradient: string; altitude: string };
export type TakeoffOption = { minimums: string; climb?: Climb; then?: Climb[]; condition?: string };
export type NotamTakeoff = { kind: 'takeoff'; runway: string; aircraft?: 'Jets' | 'Props'; options: TakeoffOption[]; reference?: string };
export type NotamTakeoffGroup = { kind: 'takeoff-group'; entries: NotamTakeoff[] };

const runway = '(?:0?[1-9]|[12]\\d|3[0-6])[LRC]?';
const runwayGroup = `${runway}(?:/(?:${runway}|[LRC]))*`;
const heading = new RegExp(`^TAKE-?OFF MINIMUMS:? RWYS? (${runwayGroup})[:,] +`);
const minimum = '(?:STANDARD|STD|\\d+\\s*-\\s*(?:\\d+ \\d+/\\d+|\\d+/\\d+|\\d+))';
const option = new RegExp(`^(${minimum})(?: WITH (?:A )?MINIMUM CLIMB(?: GRADIENT)?(?: OF)? ` +
  '(\\d+(?:\\.\\d+)?)\\s*(?:FT/NM|FT PER NM|FEET PER NM) TO (\\d+))?' +
  '(?: (FOR CLIMB IN VISUAL CONDITIONS))?$');
const stage = /^MINIMUM CLIMB(?: GRADIENT)?(?: OF)? (\d+(?:\.\d+)?)\s*(?:FT\/NM|FT PER NM|FEET PER NM) TO (\d+)$/;

/** Parse every alternative, or leave the entire clause as prose. Never borrow a prior runway. */
export function takeoffMinimums(source: string): NotamTakeoff | undefined {
  if (source.length > 2048) return undefined;
  let text = source.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  const match = heading.exec(text);
  if (!match) return undefined;
  text = text.slice(match[0].length);
  const reference = / (\(\d{4}-[A-Z0-9, /-]+\))$/.exec(text);
  if (reference) text = text.slice(0, reference.index);
  const parts = text.split(/,? OR /);
  if (parts.length > 3) return undefined;
  const options: TakeoffOption[] = [];
  for (const part of parts) {
    if (part === 'DEPARTURE NA' && parts.length > 1) { options.push({ minimums: 'Departure not authorized' }); continue; }
    const stages = part.split(', THEN ');
    if (stages.length > 4) return undefined;
    const parsed = option.exec(stages[0]!);
    if (!parsed) return undefined;
    const then = stages.slice(1).map(s => stage.exec(s));
    if (then.some(s => !s) || then.length && (!parsed[2] || parsed[4])) return undefined;
    options.push({ minimums: /^(?:STANDARD|STD)$/.test(parsed[1]!) ? 'Standard minimums' : parsed[1]!,
      ...(parsed[2] ? { climb: { gradient: parsed[2], altitude: parsed[3]! } } : {}),
      ...(then.length ? { then: then.map(s => ({ gradient: s![1]!, altitude: s![2]! })) } : {}),
      ...(parsed[4] ? { condition: 'For climb in visual conditions' } : {}) });
  }
  return { kind: 'takeoff', runway: match[1]!, options, ...(reference ? { reference: reference[1]! } : {}) };
}

/** Aircraft-specific branches share only the explicit takeoff heading, never a runway or requirement. */
export function takeoffMinimumsGroup(source: string): NotamTakeoff | NotamTakeoffGroup | undefined {
  const single = takeoffMinimums(source); if (single) return single;
  if (source.length > 2048) return undefined;
  const text = source.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  if (!/^TAKE-?OFF MINIMUMS: (?:JETS|PROPS): /.test(text)) return undefined;
  const parts = text.replace(/^TAKE-?OFF MINIMUMS: /, '').split(/, (?=(?:JETS|PROPS): )/);
  if (parts.length > 8) return undefined;
  const entries: NotamTakeoff[] = [];
  for (const part of parts) {
    const branch = /^(JETS|PROPS): (.+)$/.exec(part); if (!branch) return undefined;
    const entry = takeoffMinimums(`TAKEOFF MINIMUMS ${branch[2]}`); if (!entry) return undefined;
    entries.push({ ...entry, aircraft: branch[1] === 'JETS' ? 'Jets' : 'Props' });
  }
  return { kind: 'takeoff-group', entries };
}
