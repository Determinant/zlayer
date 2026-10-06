const number = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const height = '(?:SFC|FL\\d+|\\d+(?:\\.\\d+)?\\s*FT)';
const altitude = new RegExp(`^(?:ACT\\s+)?(${height}\\s*-\\s*(?:UNL|${height})(?:\\s+(?:AGL|MSL))?)(?=\\s|[.,]|$)`);
const phone = '\\d{3}-\\d{3}-\\d{4}(?:/\\d+)?';
const name = "[A-Z][A-Z'-]*(?: [A-Z][A-Z'-]*){0,3}";
const facility = `${name} ?(?:/[A-Z0-9]{2,5} ?/ ?(?:ARTCC|TRACON|APP|ARAC|CERAP)|(?:ARTCC|TRACON|APP|ARAC|CERAP) /[A-Z0-9]{2,5}/)`;
const day = '(?:MON|TUE|WED|THU|FRI|SAT|SUN)';
const gulfArea = '(?:ALAMINOS CANYON|BRAZOS AREA|CORPUS CHRISTI|EAST BREAKS|GALVESTON AREA|KEATHLEY CANYON|LUND|WALKER RIDGE|MUSTANG ISLAND AREA|PORT ISABEL|WEST CANYON AREA|HIGH ISLAND AREA|EAST CAMERON AREA|WEST CAMERON AREA|DE SOTO CANYON|DESTIN DOME|MAIN PASS AREA|VIOSCA KNOLL|PENSACOLA|SOUTH(?: AND EAST)? ADDITION|EAST ADDITION|SOUTH EXTENSION)(?: (?:SOUTH|EAST) ADDITION)?';

// These recognize complete operational fields, not a license to ignore the rest
// of a sentence. Any unconsumed qualification keeps the entire boundary textual.
const operational = [
  /^(?:ACT|AVOIDANCE ADZ|MILITARY UAS OPERATIONS|PAYLOAD FALLING FM FL\d+)\b/,
  /^(?:FLAGGED AND LGTD|NOT LGTD|LGT U\/S|NOT U\/S|LGTD)\b/,
  new RegExp(`^(?:DLY|${day}(?:-${day})?)(?=\\s|[.,]|$)`),
  /^(?:\d{4}|SR|SS)-(?:\d{4}|SR|SS)(?=\s|[.,]|$)/,
  /^\d{10}-(?:\d{10}(?:EST)?|PERM)(?=\s|[.,]|$)/,
  /^FREQ \d{3}\.\d+\b/,
  /^\(\d{4}-[A-Z]{3}-\d+-\d+\)/,
  /^\(COA-[A-Z]{3}-\d{4}-[A-Z]{3}\)/,
  new RegExp(`^${facility},? (?:TEL|TELEPHONE) ${phone},? IS THE (?:FAA )?CDN FAC(?:ILITY)?\\b`),
  new RegExp(`^${name} DISPATCH TEL ${phone} OR FREQ \\d{3}\\.\\d+ ${name} IS IN CHARGE OF THE OPERATION\\b`),
  new RegExp(`^(?:TEL|TELEPHONE) ?${phone}\\b`),
];
const laser = [
  /^LASER (?:LGT|LIGHT) BEAMS? MAY BE INJ(?:URIOUS|UROUS) TO PILOTS?(?: AND |\/)PAX EYES WI \d+FT VER(?:(?: AND| OR) \d+(?:FT)? LATERALLY)? OF THE (?:LGT|LIGHT) SOURCE\b/,
  /^FLASH ?BLINDNESS OR COCKPIT ILLUMINATION MAY OCCUR BEYOND THESE DIST(?:ANCES)?\b/,
  /^APACHE POINT OBSERVATORY\b/,
  /^AT AN ANGLE OF \d+(?:\.\d+)?DEG\b/,
  /^AVOID AIRBORNE HAZARD BY \d+(?:\.\d+)?NM\b/,
  /^THIS BEAM IS INJURIOUS TO PILOT\/AIRCREW AND PAX EYES\b/,
];
const space = [
  /^(?:EFFECTIVE )?\d{9,10} UTC \(\d{4} LOCAL \d{2}\/\d{2}\/\d{2}\) UNTIL \d{9,10} UTC \(\d{4} LOCAL \d{2}\/\d{2}\/\d{2}\)/,
  /^SPACE OPS AREA: ACFT ADVISED TO AVOID DEFINED AREA DUE TO SPACE OPS\b/,
  /^A\. FLT LIMITATION IN THE PROXIMITY OF SPACE FLT OPS, OPS BY FAA CERT PILOTS OR U\.S\. REG ACFT ARE PROHIBITED WI THE DEFINED AIRSPACE\b/,
  /^B\. ACFT SUPPORTING THE RECOVERY OF THE SPACE VEHICLE ARE EXEMPT FM THIS ADVISORY\b/,
  /^C\. PILOTS MUST CONSULT ALL NOTAMS REGARDING THIS OPS AND MAY CONTACT [A-Z]{3} FOR CURRENT AIRSPACE STATUS\b/,
];
const other = [
  /^IN THE INTEREST OF SAFETY,? ALL NON-?PARTICIPATING (?:ACFT|AIR TRAFFIC) ARE (?:ADZ|ADVISED) TO AVOID THE (?:NOTAMED )?AREAS?\b/,
  /^IFR (?:ACFT|TFC|AIRCRAFT) UNDER ATC JURISDICTION (?:CAN|SHOULD) ANTICIPATE (?:CLEARANCE|RERTE) AROUND THE (?:NOTAMED )?AREAS?\b/,
  /^DROPSONDE RELEASES WILL BE CONDUCTED ALONG THE TRACK AND WI THE AREA INDICATED\b/,
  /^BCST ON \d+\.\d+\/\d+\.\d+ WILL OCCUR PRIOR TO EACH RELEASE\b/,
  /^THIS NOTICE IS FOR INFO PURPOSES AND IS NOT INTENDED TO EXCLUDE THE USE OF THE AIRSPACE\b/,
  new RegExp(`^FOR FURTHER INFO PLEASE CTC [A-Z ]{1,60} AT TEL ?${phone} OR [A-Z0-9._-]+@[A-Z0-9.-]+ OR MX CONTROL AT TEL ${phone}\\b`),
  /^THIS AREA LIES (?:[NSEW] OF W\d+[A-Z](?: AND [NSEW] OF W\d+[A-Z])?|ABV W\d+[A-Z]|BTN W\d+[A-Z] AND W\d+[A-Z])\b/,
  /^NORMALLY ACTIVATED WITH W\d+\b/,
  /^MIAMI CENTER WILL NOT APPROVE IFR FLT(?: AND VFR FLT SHOULD EXER EXTREME CAUTION)?\b/,
  /^THIS ALT RESERVATION LIES ABV R\d+[A-Z](?:\/[A-Z])*, AVON EAST MOA, N OF AVON EAST MOA, AND THE W HALF OF BASINGER MOA\b/,
  /^ALL ARRIVALS AND DEPARTURES AT [A-Z]{4} MUST CHECK NOTAMS [A-Z]\d{4}\/\d{2}(?:, [A-Z]\d{4}\/\d{2})* AND COMPLY WITH REQUIREMENTS\b/,
  /^A \d+ IN DIAMETER ALUMINUM SPHERE WILL BE CONNECTED TO THE \d+ FT DIAMETER BALLOON BY A \d+ FT WIRE\b/,
  /^SPHERES ARE EXPECTED TO CLIMB UP TO \d+FT\b/,
  /^[A-Z]{4} DOES NOT TRACK THESE BALLOONS OR SPHERES\b/,
  new RegExp(`^QUESTIONS CAN BE DIRECTED TO [A-Z ]{1,60} TEL ${phone}\\b`),
];

export type AreaTail = { labelHeight: string | undefined; radius: number | undefined; outer: boolean; preserveText: boolean; runwaySector: boolean };

/** Limits -> optional altitude tiers -> operational fields. Every transition
 * consumes the next field. Unknown spatial/prose suffixes cannot silently turn
 * a qualified portion into a whole circle or polygon. Source is never rewritten. */
export function areaTail(source: string, header: string, radius: number | undefined, followedByArea: boolean): AreaTail | undefined {
  let rest = source.replace(/\s+/g, ' ').trim();
  if (followedByArea) rest = rest.replace(/\s+AND\s*$/, '');
  const result: AreaTail = { radius, labelHeight: undefined, outer: false, preserveText: false, runwaySector: false };
  const gps = /\bGPS\b/.test(header) && radius !== undefined;
  const service = /\b(?:ADS-[BR]|TIS-B|FIS-B)\b/.test(header) && !gps;
  const patterns = [...operational, ...(/\bLASER\b/.test(header) ? laser : []), ...(/SPACE/.test(header) ? space : []), ...other];
  let tiersExpected = false;
  for (let fields = 0; fields < 128; fields++) {
    rest = rest.replace(/^(?:\s|[,;]|\.(?!\d))+/, '');
    if (!rest) {
      if (tiersExpected && !result.outer) return;
      if (result.radius !== radius) { result.preserveText = true; result.labelHeight = undefined; }
      return result;
    }
    let match: RegExpExecArray | null = altitude.exec(rest);
    if (match) result.labelHeight ??= match[1];
    if (!match && /^(?:OBST\b|AIRSPACE WIND TURBINE FARM\b)/.test(header)) {
      match = /^(\d+(?:\.\d+)?FT|UNKNOWN)(?: \((\d+(?:\.\d+)?FT AGL|UNKNOWN)\))?(?=\s|[.,]|$)/.exec(rest);
      if (match && match[1] !== 'UNKNOWN') result.labelHeight ??= `${match[1]} MSL${match[2] ? ` (${match[2]})` : ''}`;
    }
    if (!match && gps && result.labelHeight) {
      match = /^DECREASING IN AREA WITH A DECREASE IN ALTITUDE DEFINED AS:/.exec(rest);
      if (match) tiersExpected = true;
      else {
        match = new RegExp(`^(${number})\\s*NM RADIUS AT (?:FL\\d+|I?\\d+\\s*FT)(?: AGL)?(?=\\s|[.,]|$)`).exec(rest);
        if (match) {
          const tier = Number(match[1]);
          if (!(tier > 0 && tier <= 600)) return;
          result.radius = Math.max(result.radius!, tier); result.outer = true;
          if (/\bI\d+FT\b/.test(match[0])) result.preserveText = true;
        }
      }
    }
    if (!match && service) match = new RegExp(`^AIRSPACE AFFECTED MAY INCLUDE GULF OF (?:AMERICA|MEXICO) AREAS OF ${gulfArea}(?:, ${gulfArea})*(?=[.]|$)`).exec(rest)
      ?? /^(?:AP )?AIRSPACE AFFECTED (?:MAY )?INCLUDES? [A-Z0-9]{2,5}(?:,\s*[A-Z0-9]{2,5})*(?=\s|[.]|$)/.exec(rest);
    if (!match && /\bFLTCK\b/.test(header)) {
      match = /^INCLUDING [A-Z0-9]{2,5} RWY \d{2}[LRC]? FINAL AND \d+(?:\.\d+)?DEG EITHER SIDE, ACFT CS [A-Z0-9]+(?=[.]|$)/.exec(rest);
      if (match) { result.runwaySector = true; result.preserveText = true; }
    }
    if (!match) {
      // Unqualified/misspelled heights stay prose and never supply a label value.
      match = /^(?:SFC-\d+(?: AGL)?|AG)(?=\s|[.,]|$)/.exec(rest);
      if (match) result.preserveText = true;
    }
    if (!match && /^SVC\b/.test(header)) match = /^MAY NOT BE AVBL, DUE TO [A-Z0-9]{2,5} TAR U\/S\b/.exec(rest);
    if (!match) for (const pattern of patterns) { match = pattern.exec(rest); if (match) break; }
    if (!match) return;
    rest = rest.slice(match[0].length);
  }
  return undefined;
}
