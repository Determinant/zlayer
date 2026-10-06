import type { NotamRecord } from '@zlayer/contracts';
import { localNotamContent, parseNotam } from './parser';
import { notamEndKind } from './validity';
import { approachMinimaGroup, type NotamMinima, type NotamMinimaGroup } from './minima';
import { readableAirportName, readableNotamText } from './readable-text';
import { takeoffMinimumsGroup, type NotamTakeoff, type NotamTakeoffGroup } from './takeoff';
import { declaredDistances, type NotamDistances } from './distances';
import { notamClauses } from './clauses';

export type NotamBodyBlock =
  | { kind: 'text' | 'context' | 'heading'; text: string; detail?: string }
  | { kind: 'instruction'; label: string; text: string }
  | NotamMinima | NotamMinimaGroup | NotamTakeoff | NotamTakeoffGroup | NotamDistances;
export type NotamPresentation = { blocks: NotamBodyBlock[]; searchText: string; sourceSpans: { start: number; end: number }[] };
const presentations = new WeakMap<NotamRecord, NotamPresentation>();
const MAX_BODY = 64 * 1024, MAX_BLOCKS = 128, MAX_CLAUSE = 2048;

function compactMinute(time: number | null): string | undefined {
  return time === null || !Number.isFinite(time) ? undefined : new Date(time).toISOString().replace(/\D/g, '').slice(2, 12);
}

/** Remove a redundant time range only when the visible validity row carries the same evidence. */
function withoutRepeatedValidity(body: string, record: NotamRecord): string {
  const range = /\s+(\d{10})-(\d{10})(EST)?\s*$/.exec(body);
  const kind = notamEndKind(record);
  return range && range[1] === compactMinute(record.startsAt) && range[2] === compactMinute(record.endsAt) &&
    kind === (range[3] ? 'estimated' : 'fixed') ? body.slice(0, range.index) : body;
}

function bodyBlock(source: string, allowValues: boolean): NotamBodyBlock {
  const text = source.replace(/\s+/g, ' ').trim();
  const minima = allowValues && approachMinimaGroup(source);
  if (minima) return minima;
  // All structured matches consume the whole clause. An extra exception/condition
  // keeps the complete source clause in view rather than creating a partial summary.
  const takeoff = allowValues && takeoffMinimumsGroup(text);
  if (takeoff) return takeoff;
  const distances = allowValues && declaredDistances(text);
  if (distances) return distances;

  const departure = /^TAKE-?OFF MINIMUMS AND \(OBSTACLE\) DEPARTURE PROCEDURES(?:,)? (?:AMDT ([A-Z0-9-]+)|(ORIG(?:-[A-Z0-9]+)?))\.{2,}$/i.exec(text);
  if (departure) return { kind: 'heading', text: 'Takeoff minimums & obstacle departure procedures', detail: departure[1] ? `Amendment ${departure[1]}` : departure[2]! };
  if (text.length <= 320) {
    const airport = /^(ODP|IAP|SID|STAR) ((?:[A-Z0-9 ,.'/-]|&(?:apos|quot|amp|#39|#34|#x27|#x22);)+), ([A-Z]{2})\.$/.exec(text);
    if (airport) return { kind: 'context', text: `${airport[1]} · ${readableAirportName(airport[2]!)}, ${airport[3]}` };
    const procedure = /^(.+), (?:AMDT ([A-Z0-9-]+)|(ORIG(?:-[A-Z0-9]+)?))\s*\.{2,}$/.exec(text);
    if (procedure) return { kind: 'heading', text: procedure[1]!, detail: procedure[2] ? `Amendment ${procedure[2]}` : procedure[3]! };
  }
  if (/^ALL OTHER DATA REMAINS AS PUBLISHED\.?$/i.test(text)) return { kind: 'text', text: 'All other data remains as published.' };
  const instruction = /^((?:(?:CHANGE|ADD|DELETE|DISREGARD) (?:[A-Z /-]{1,64} )?NOTES?(?: TO READ)?)|(?:[A-Z /-]{1,40} )?NOTES?|NOTE FOR CAT [IVX]+|CAT [IVX]+ NOTE|[*#]?\s*MISSED APPROACH):\s*(.+)$/i.exec(text);
  if (instruction) {
    const labels: Record<string, string> = { 'CHANGE NOTE TO READ': 'Replace note', 'CHANGE NOTES TO READ': 'Replace notes',
      'CHANGE EQUIPMENT NOTE TO READ': 'Replace equipment note', 'CHANGE NOTE': 'Change note', 'CHANGE NOTES': 'Change notes',
      'ADD NOTE': 'Add note', 'ADD NOTES': 'Add notes', 'DISREGARD NOTE': 'Disregard note', 'DISREGARD NOTES': 'Disregard notes',
      'DELETE NOTE': 'Delete note', 'DELETE NOTES': 'Delete notes',
      'DISREGARD CHART NOTE': 'Disregard chart note', 'PROFILE NOTE': 'Profile note', 'NOTE': 'Note',
      'MISSED APPROACH': 'Missed approach', '*MISSED APPROACH': '*Missed approach', '#MISSED APPROACH': '#Missed approach',
      'ADD TAKEOFF OBSTACLE NOTE': 'Add takeoff obstacle note', 'ADD TAKEOFF OBSTACLE NOTES': 'Add takeoff obstacle notes' };
    return { kind: 'instruction', label: labels[instruction[1]!.toUpperCase()] ?? readableNotamText(instruction[1]!.replace(/^CHANGE (.+NOTES?) TO READ$/, 'REPLACE $1').replace(/\bINOP\b/g, 'INOPERATIVE')),
      text: noteWording(instruction[2]!) };
  }
  const removal = /^(DISREGARD|DELETE) (.+)$/i.exec(text);
  if (removal) return { kind: 'instruction', label: removal[1]!.toUpperCase() === 'DISREGARD' ? 'Disregard' : 'Delete', text: removal[2]! };
  if (/^FOR INOP(?:ERATIVE)?\b/i.test(text)) return { kind: 'instruction', label: 'Inoperative equipment condition', text: noteWording(text) };
  if (/^(?:UNLESS|EXCEPT WHEN)\b/.test(text)) return { kind: 'instruction', label: 'Exception', text: noteWording(text) };
  if (/^(?:IF|WHEN|PROVIDED)\b/.test(text)) return { kind: 'instruction', label: 'Condition', text };
  return { kind: 'text', text: source.trim() };
}

function noteWording(text: string): string {
  // Expand only these unambiguous note phrases; general casing happens after parsing.
  return text.replace(/^FOR INOP(?:ERATIVE)?\b/, 'For inoperative')
    .replace(/\bALL CATS\b/g, 'all categories');
}

/** Clock-free, bounded presentation, independent of plate applicability and feed health. */
export function presentNotam(record: NotamRecord): NotamPresentation {
  const cached = presentations.get(record); if (cached) return cached;
  const body = parseNotam(record).body;
  let blocks: NotamBodyBlock[] = [{ kind: 'text', text: body || 'No text supplied.' }];
  let sourceSpans = [{ start: 0, end: body.length }];
  if (body && body.length <= MAX_BODY) {
    const content = withoutRepeatedValidity(localNotamContent(body, record), record).trim();
    const clauses = notamClauses(content, MAX_BLOCKS);
    if (clauses?.length) {
      const offset = body.indexOf(content);
      sourceSpans = clauses.map(clause => ({ start: offset + clause.start, end: offset + clause.end }));
      blocks = clauses.map(clause => clause.source.length <= MAX_CLAUSE
        ? bodyBlock(clause.source, clause.state === 'operative') : { kind: 'text', text: clause.source });
    }
    const identifiers = [...record.locations, ...record.icaoLocations, record.accountability];
    const readable = (text: string) => readableNotamText(text, identifiers);
    const format = (block: NotamBodyBlock): NotamBodyBlock => {
      if (block.kind === 'text' || block.kind === 'instruction') return { ...block, text: readable(block.text) };
      if (block.kind === 'minima-group') return { ...block, entries: block.entries.map(entry => format(entry) as NotamMinima) };
      if (block.kind === 'minima') return { ...block,
        ...(block.context ? { context: readable(block.context) } : {}),
        ...(block.condition ? { condition: readable(block.condition) } : {}) };
      return block;
    };
    blocks = blocks.map(format);
  }
  const searchText = blocks.map(notamBlockText).join(' ');
  const result = { blocks, searchText, sourceSpans };
  presentations.set(record, result);
  return result;
}

/** Textual reading order for search and source-preservation audits. */
export function notamBlockText(block: NotamBodyBlock): string {
  if (block.kind === 'minima-group') return block.entries.map(notamBlockText).join(' ');
  if (block.kind === 'takeoff-group') return `Takeoff minimums ${block.entries.map(b => notamBlockText(b).replace(/^Takeoff minimums /, '')).join(' ')}`;
  if (block.kind === 'distances') return `Runway ${block.runway} Declared distances ${block.values.map(v => `${v.label} ${v.value}`).join(' ')}`;
  if (block.kind === 'takeoff') return `Takeoff minimums ${block.aircraft ? block.aircraft + ' ' : ''}Runway ${block.runway} ${block.options.map(option =>
    `${option.minimums} ${option.climb ? `Minimum climb ${option.climb.gradient} ft/NM to ${option.climb.altitude}` : ''}${option.then?.map(c => ` Then minimum climb ${c.gradient} ft/NM to ${c.altitude}`).join('') ?? ''} ${option.condition ?? ''}`).join(' Or ')} ${block.reference ?? ''}`;
  if (block.kind === 'minima') return `${block.context ?? ''} ${block.scope} ${block.rows.map(row =>
    `${row.values.map(v => `${v.label} ${v.value === 'NA' ? 'Not authorized' : v.value}`).join(' ')} ${row.categories ?? ''}`).join(' ')} ${block.condition ?? ''}`;
  return block.kind === 'instruction' ? `${block.label} ${block.text}` : `${block.text} ${block.detail ?? ''}`;
}
