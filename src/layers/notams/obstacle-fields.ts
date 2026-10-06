/** Non-positional fields of a standalone obstacle report. These grammars never
 * turn an ASN, relative annotation or unqualified height into a map position. */
export function obstacleKind(prefix: string) {
  const kind = /^(?:(?:OBST(?:ACLE)?|AIRSPACE) )?(REFINERY REACTORS?|CRANES?|(?:(?:WATER ?|POWER |TRANSMISSION |COOLING )?(?:TOWERS?|TWRS?|TW))(?: LINES?)?|(?:DEEP SPACE )?ANTENNAS?|POWER LINES?|STACKS?|BLDGS?|BUILDINGS?|WIND TURBINES?|WINDMILLS?|POLES?|(?:OIL )?RIGS?|TREES?|SILOS?|BRIDGES?|HILLS?|SHIP MASTS?|PARKED ACFT|DIRT (?:STOCKPILES?|PILES?)|LGT)(?: LGT)?\s*/.exec(prefix);
  if (!kind) return;
  const identifier = prefix.slice(kind[0].length).trim();
  const closed = /^(?:\((?:(?:ASN|ASR)[ -]*#?\s*)?[A-Z0-9 /.,-]+\))?$/.test(identifier);
  // Captured ICAO renderings truncate only the ASN suffix/closing parenthesis.
  // The complete coordinate and heights remain separate fields; keep all prose.
  const truncated = /^\(ASN \d{4}-[A-Z]{3}-\d+-O$/.test(identifier);
  if (!closed && !truncated) return;
  const name = kind[1]!.replace(/\bTWR\b|\bTW\b/, 'TOWER').replace(/\bTWRS\b/, 'TOWERS')
    .replace(/^WATERTOWER/, 'WATER TOWER').replace(/^BLDGS?$/, word => word === 'BLDGS' ? 'BUILDINGS' : 'BUILDING')
    .replace(/^LGT$/, 'OBSTRUCTION LIGHT').toLowerCase();
  return { name: name[0]!.toUpperCase() + name.slice(1), grouped: /S$/.test(kind[1]!),
    lighting: /\bLGT\b/.test(kind[0]), preserveText: truncated || !/^OBST /.test(prefix) };
}

export function obstacleAnnotation(source: string): number {
  // A parenthesized height belongs to the next field, not an airport annotation.
  if (/^\s*\(\d+(?:\.\d+)?\s*FT\s+(?:AGL|MSL)\s*\)/.test(source)) return 0;
  const direction = '(?:[NSEW]{1,3}|(?:NORTH|SOUTH)(?: (?:NORTH|SOUTH))?(?: ?(?:EAST|WEST))?|EAST|WEST)';
  const relative = new RegExp(`^\\s*\\(\\s*[.\\d]+\\s*(?:NM|FT)\\s*(?:${direction}\\s+)?(?:OF\\s+)?(?:APCH END(?: OF)? RWY \\d{1,2}[LRC]?|RWY \\d{1,2}[LRC]?(?:/\\d{1,2}[LRC]?)?|[A-Z0-9]{2,5}(?: [A-Z0-9]{2,5}){0,2})\\s*\\)`);
  return (relative.exec(source) ?? /^\s*\([A-Z0-9]{2,5}\d{6}(?:\.\d+)?\s*\)/.exec(source))?.[0].length ?? 0;
}

export function obstacleHeights(source: string) {
  const paired = /^\s+(UNKNOWN|-?\d+(?:\.\d+)?(?:\s*FT(?: MSL)?)?)\s*\((UNKNOWN|\d+(?:\.\d+)?\s*FT(?: AGL)?)\)(?=\s|\.|$)/.exec(source);
  if (paired) {
    if (Math.abs(parseFloat(paired[1]!)) > 99_999 || parseFloat(paired[2]!) > 99_999) return;
    const msl = /^(-?\d+(?:\.\d+)?)\s*FT(?: MSL)?$/.exec(paired[1]!);
    const agl = /^(\d+(?:\.\d+)?)\s*FT AGL$/.exec(paired[2]!);
    return { length: paired[0].length, elevationMslFt: msl ? Number(msl[1]) : undefined, heightAglFt: agl ? Number(agl[1]) : undefined,
      complete: !!(msl || paired[1] === 'UNKNOWN') && !!(agl || paired[2] === 'UNKNOWN') };
  }
  const single = /^\s+(?:\((\d+(?:\.\d+)?)FT AGL\)|(\d+(?:\.\d+)?)FT(?: (AGL|MSL))?)(?=\s|\.|$)/.exec(source);
  if (!single || Number(single[1] ?? single[2]) > 99_999) return;
  const heightAglFt = single[1] !== undefined ? Number(single[1]) : single[3] === 'AGL' ? Number(single[2]) : undefined;
  const elevationMslFt = heightAglFt === undefined ? Number(single[2]) : undefined;
  return { length: single[0].length, heightAglFt, elevationMslFt, complete: false };
}
