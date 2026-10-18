import { readPirepFields } from './text';
import { numeric, feet, excerpt } from './content-tokens';
import { parsePirepHazard } from './content-hazards';
import { readPirepSky } from './content-sky';
import { readPirepAltitude } from './content-altitude';
import { pirepAircraftName } from './aircraft';
export { readPirepSky };
export const readPirepHazard = (text: string, field: 'TB' | 'IC') => parsePirepHazard(text, field)?.values;

type Content = { altitudeFt: number | null; aircraft: string; turbulence: string[]; icing: string[]; sky: string[]; contentNotes?: string[] };
export function pirepContent(raw: string, source: Omit<Content, 'contentNotes'>, qualifiedAltitude: boolean): Content {
  const parsed = readPirepFields(raw);
  if (!parsed) return source;
  const result = { ...source, contentNotes: [] as string[] };
  const levels = parsed.fields.FL;
  if (levels) {
    const level = levels.length === 1 ? levels[0]! : undefined;
    const altitude = level === undefined ? { kind: 'unsupported' as const } : readPirepAltitude(level);
    const evidence = excerpt(levels.map(value => `/FL${value}`).join(' '));
    result.altitudeFt = null;
    if (altitude.kind === 'single' && !qualifiedAltitude) {
      const value = altitude.feet;
      if (source.altitudeFt !== null && source.altitudeFt !== value) {
        result.altitudeFt = null;
        result.contentNotes.push(`Altitude conflict: /FL${level} indicates ${value} ft MSL; AWC supplies ${source.altitudeFt} ft MSL`);
      } else result.altitudeFt = value;
    } else if (altitude.kind === 'units-unknown') {
      result.contentNotes.push(`Altitude unresolved: ${evidence}; nonstandard digit count without explicit units`);
    } else if (altitude.kind === 'range') {
      result.contentNotes.push(altitude.high === undefined ? `Altitude range incomplete: ${evidence}; starts at ${altitude.low} ft MSL, other endpoint missing`
        : `Altitude range: ${altitude.low}–${altitude.high} ft MSL (${evidence}); no single altitude`);
    } else if (altitude.kind === 'qualified') {
      result.contentNotes.push(`Altitude qualified: ${altitude.qualifier} ${altitude.feet} ft${altitude.qualifier.includes('AGL') ? '' : ' MSL'} (${evidence})`);
    } else if (altitude.kind === 'unspecified' && altitude.reason) {
      result.contentNotes.push(`Altitude unspecified: ${evidence}; ${altitude.reason}`);
    } else if (altitude.kind === 'unsupported') {
      const type = parsed.fields.TP?.length === 1 ? parsed.fields.TP[0] : undefined;
      if (level && numeric(type) && pirepAircraftName({ type: 'PIREP', aircraft: level })) {
        result.aircraft = '';
        result.contentNotes.push(`Aircraft / altitude unresolved: ${evidence} /TP${type}; possible transposition: ${level} at ${feet(type)} ft MSL (unconfirmed)`);
      } else result.contentNotes.push(`Altitude unresolved: ${evidence}; no single unambiguous altitude`);
    }
  }
  for (const [field, property] of [['TB', 'turbulence'], ['IC', 'icing'], ['SK', 'sky']] as const) {
    const values = parsed.fields[field]?.filter(Boolean);
    if (!values?.length) continue;
    result[property] = values.flatMap(value => {
      if (field === 'SK') return readPirepSky(value) ?? [`Reported /SK: ${excerpt(value)} (not fully decoded)`];
      const conditions = parsePirepHazard(value, field);
      if (conditions?.notes) result.contentNotes.push(...conditions.notes);
      return conditions?.values ?? [`Reported /${field}: ${excerpt(value)} (not fully decoded)`];
    });
  }
  const { contentNotes, ...content } = result;
  return contentNotes.length ? result : content;
}
