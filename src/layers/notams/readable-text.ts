// Case ordinary prose, rather than guessing which unknown words are identifiers.
// Codes, contractions and unrecognized tokens keep the publisher's spelling.
const prose = new Set(`
  ABOVE ACCEPT ACCESS ADD ADDED ADJACENT ADVISE ADVISED AFFECTED AFTER AIR AIRCRAFT AIRFIELD
  AIRPORT AIRSPACE ALL ALLEY ALTERNATE ALTERNATIVELY ALTITUDE ALTIMETER AN AND ANGLE
  APPLY APPROACH APPROACHES APPROVAL APPROVED APRON ARC ARE AREA ARRIVAL ARRIVALS AS
  ASSIGNED AT AUTHORIZED AUTOLAND AUTOMATED AUTOPILOT AVAILABLE AVIATION BAR BARGE
  BARRICADED BASE BEFORE BEGINNING BELOW BETWEEN BEYOND BIRD BLACKBIRDS BORDER BOTH
  BILLBOARD BOUNDARY BUILDING BUILDINGS BURN BY CARGO CARRIERS
  CATEGORIES CATEGORY CAUTION CENTER CENTERLINE CHANGE CHANGED CHANGES CHART CHARTED CHECK
  CHARTS CIRCLING CLEARANCE CLIMB CLIMBING CLOSE CLOSED CLOSURE COINCIDENT COMMISSIONED
  COMMUNICATIONS CONDITIONS CONSTRUCTION CONTACT CONTINUE CONTROLLED CONVERGING COPTER COUPLED CRANE
  CRANES CROSS CROSSING CUTTING DAILY DATA DAY DEGREES DECLARED DECREASE DEFINED DEICE
  DEICING DELETE DEPARTING DEPARTURE DEPARTURES DEPICTED DESCRIPTION DETECTION DIRECT
  DIRECTION DIRECTIONAL DISPLACED DISREGARD DISTANCE DIVERSE DOES DOWN DRILLING DUE DURING EACH EAST
  EDGE EIGHT EITHER ELEVATED ELEVATION END ENGINE ENTRANCE ENTRY EQUIPMENT EQUIPPED
  EXCEPT EXCAVATION EXIT EXPECT FACING FADED FEET FIELD FILE FILED FINAL FIRST FIVE FIX
  FIXED FIXES FLAGGED FLIGHT FOLLOW FOLLOWING FOR FORCE FOUR FROM FUEL GATE GENERAL GEOGRAPHIC GLIDEPATH GLIDESLOPE
  GRADIENT GRADIENTS GRASS GROOVED GROUND GUARD GUIDANCE HANGAR HEADING HEADINGS HEIGHT
  HARDSTAND HELICOPTER HIGH HIGHWAY HOLD HOLDING HOURS IF IN INBOUND INCLUDING INCREASE INCREASED
  INNER INOPERATIVE INSPECTION INSTRUCTIONS INSTRUMENT INTERCEPT INTERSECTION INTERSTATE
  IRREGULAR IS KNOTS LANDING LATER LEAD LEFT LENGTH LESS LIGHT LIGHTED LIGHTING LIGHTS
  LIMIT LIMITED LIMITS LOCATED LOCATION LOST LOW LOWER MAINTAIN MARKER MARKING MARKINGS
  MAXIMUM MEET MIDFIELD MIGRATORY MINIMUM MINIMUMS MINUTES MISSED MISSING MORE MULTIPLE MUST NEW NIGHT NINE NO
  NON NONMOVEMENT NORMAL NORTH NORTHEAST NORTHWEST NOT NOTE NOTES NOTICE NOW NUMBER
  NUMEROUS OBSTACLE OBSTACLES OBSTRUCTION OBSTRUCTIONS OCCUR OF OFF ON ONE ONLY OPEN
  OPERATING OPERATIONS OR ORIGIN OTHER OUT OUTLET OVER PAD PAINTED PARALLEL PART
  PAVEMENT PER PERMANENT PILOT PLANVIEW PLATES POINT POLE PORTION PREVIOUSLY PRIOR PROCEDURE
  PROCEDURES PROFILE PROGRESS PROVIDE PROVIDED PUBLISHED RADAR RADIAL RADIALS RADIO RADIUS RAISED RAMP RATES
  READ RED REDUCED REDUCTION REMAIN REMAINING REMAINS REMOTE REMOVED REPLACE REQUIRED
  REQUIRES REST RESTRICTED RESTRICTION RESTRICTIONS RIGHT RIG ROLLOUT ROUTE ROUTES RUNUP
  RUNWAY RUNWAYS SAFETY SAME SCHEDULE SECURITY SEE SEGMENTS SEQUENCED SERVICE SEVEN SHOULDER
  SIDE SIDESTEP SIGN SIGNS SIMULTANEOUS SIX SOUTH SOUTHEAST SOUTHWEST SPECIAL SPECIFIC
  SPEED SPOT STANDARD STARTING STATUS STEEL STEPDOWN STOP SUITABLE SURFACE SYSTEM
  TABLE TAIL TAKE TAKEOFF TAXI TAXILANE TAXIWAY TEMPORARY TERMINAL THAN THAT THE THEIR THEN
  THENCE THERE THESE THIS THREE THRESHOLD THROUGH TIME TO TOP TOUCHDOWN TOWER TOWERS TRACK TRAFFIC TYPE
  TRANSIENT TRANSITION TRANSITIONS TREE TREES TURN TWO UNABLE UNCHANGED UNCOMPENSATED
  UNDER UNKNOWN UNLESS UNMONITORED UNTIL UNUSABLE UP USE USING VALUES VECTOR VECTORS
  VEHICLE VIA VISIBILITY VISIBLE VISUAL WEST WET WHEN WHITE WIDTH WINDCONE WINDMILL
  WINGSPAN WITH WITHIN WITHOUT WORK YELLOW
`.trim().split(/\s+/));

// These words following a navigation preposition introduce prose, not a fix.
const connective = new Set(`ALL AN AND AS AT BELOW BY EACH FOR FROM IN INTERCEPT
  MAINTAIN OF ON ONE OR READ THE THEN THIS TO TWO USE WITH`.split(/\s+/));
const facilityDescription = new Set(`A ALL AN ANY APPROACH DIVERSE EACH INOPERATIVE MISSED
  OBSTACLE PUBLISHED RADAR REQUIRED STANDARD STEPDOWN SUITABLE THE`.split(/\s+/));

/** Known source character escapes, decoded once as text, never as HTML. */
export function notamDisplayText(text: string): string {
  const entities: Record<string, string> = { '&apos;': "'", '&#39;': "'", '&#x27;': "'",
    '&quot;': '"', '&#34;': '"', '&#x22;': '"', '&amp;': '&' };
  return text.replace(/&(?:apos|quot|amp|#39|#34|#x27|#x22);/g, entity => entities[entity]!);
}

/** Display characters and casing only; raw strings and numeric grammar never use this output. */
export function readableNotamText(text: string, identifiers: readonly string[] = []): string {
  text = notamDisplayText(text);
  const protectedWords = new Set(identifiers);
  const protectedOffsets = new Set<number>();
  // ASCII folding keeps offsets stable even in a publisher's non-English text.
  const upper = text.replace(/[a-z]/g, char => char.toUpperCase());
  // English-word fixes (WHITE, CROSS, etc.) need the same treatment as TYNIE.
  // Protect occurrences, not every use of that word elsewhere in the instruction.
  for (const match of upper.matchAll(/\b(?:DIRECT(?:\s+TO)?|TO|FROM|AT|OVER|CROSS|VIA)\s+([A-Z]{2,5})\b/g)) {
    const direct = match[0].startsWith('DIRECT') && match[1] !== 'TO';
    if (direct || (!connective.has(match[1]!) && !(match[1] === 'POINT' && /^\s+OF\b/.test(upper.slice(match.index + match[0].length))))) {
      protectedOffsets.add(match.index + match[0].lastIndexOf(match[1]!));
    }
  }
  for (const match of upper.matchAll(/\b([A-Z]+)\s+(?=(?:FIX|INT|INTXN|VOR(?:\/DME)?|VORTAC|NDB|TRANSITION|DEPARTURE|ARRIVAL)\b)/g)) {
    if (!facilityDescription.has(match[1]!)) protectedOffsets.add(match.index);
  }
  for (const match of upper.matchAll(/\b(?:TWY|TXL)\s+([A-Z]{1,2})\b/g)) {
    protectedOffsets.add(match.index + match[0].lastIndexOf(match[1]!));
  }
  let sentenceStart = true, lastEnd = 0;
  return text.replace(/\b[A-Za-z][A-Za-z0-9]*\b/g, (word: string, offset: number) => {
    if (/[.!?][\s)"']+/.test(text.slice(lastEnd, offset))) sentenceStart = true;
    const first = sentenceStart; sentenceStart = false; lastEnd = offset + word.length;
    if (!prose.has(word) || protectedWords.has(word) || protectedOffsets.has(offset) ||
      // A code/reference component (S-ILS, TEST.ABC, ASW-123), not a prose word.
      /[\d/]/.test(text[offset - 1] ?? '') || /[\d/]/.test(text[offset + word.length] ?? '') ||
      /(?:[./][A-Z0-9]|-\d)/.test(text.slice(offset + word.length, offset + word.length + 2)) ||
      /(?:[A-Z0-9][./]|\d-)$/.test(text.slice(Math.max(0, offset - 2), offset))) return word;
    const lower = word.toLowerCase();
    return first ? lower[0]!.toUpperCase() + lower.slice(1) : lower;
  });
}

const airportCodes = new Set('AAF AFB ARB CGAS FLD INTL JRB MCAS MUNI NAS NOLF NS RGNL USAF USCG'.split(' '));
/** Called only on the name/city span of a recognized airport heading, excluding its state. */
export function readableAirportName(text: string): string {
  return notamDisplayText(text).replace(/\b[A-Z]+\b/g, word => airportCodes.has(word) ? word : word[0]! + word.slice(1).toLowerCase());
}
