import { evidence, subjects, normalizeRunway, type NotamTarget, type NotamFact, type NotamFactKind, type NotamFlairTone, type NotamEvidence, type ParsedNotam } from './interpretation';
import { operativePrefix } from './clauses';
import { approachTitleIdentity } from './procedure-title';
import type { NotamNavigation } from './navigation-notice';

const MAX_FACTS = 20;
const runwayId = '(?:0?[1-9]|[12]\\d|3[0-6])[LRCU]?';
const runwayPair = `${runwayId}(?:/${runwayId})?`;
const taxiwayId = '[A-Z0-9]+(?:/[A-Z0-9]+)*';
const namedArea = '(?:(?:[A-Z0-9]+ ){0,5}(?:RAMP(?: ACCESS)?|APN|HARDSTAND)|(?:GATE|SPOT) [A-Z0-9]+|DEICE PAD [A-Z0-9]+)';
const endpoint = `(?:(?:APCH END )?RWY ${runwayPair}|(?:TWY|TXL) ${taxiwayId}|${namedArea})`;
const taxiwaySegment = `(?:TWY )?${taxiwayId}(?: BTN ${endpoint} AND ${endpoint})?`;
const taxiwayClosure = new RegExp(`^\\s*TWY ${taxiwaySegment}(?:, ${taxiwaySegment})* CLSD\\b`, 'i');
const partialRunwayClosure = new RegExp(`^\\s*RWY ${runwayPair} (?:[NS][EW]?|[EW]) \\d+\\s*FT CLSD\\b`, 'i');
const nonAffirmative = /\b(?:NOT|NO|NEVER|CAN|CANNOT|MAY|MIGHT|WILL|WOULD|COULD|SHOULD|WAS|WERE|WHILE|EXPECTED|PLANNED|PROPOSED|READS?|SAYS?)\b/i;
const quoted = /["“”]/;
const withdrawn = /\b(?:DISREGARD|DELETE|CANCEL(?:S|LED)?|INCORRECT|ERRONEOUS)\b/i;
const qualifiedClosure = /^\s*(?:[.,]\s*)?(?:TO|FOR|EXC|EXCEPT|ONLY|WHEN|UNLESS|IF|PROVIDED|DLY|MON|TUE|WED|THU|FRI|SAT|SUN|UFN)\b|\b(?:EXC|EXCEPT|ONLY|WHEN|UNLESS|IF|PROVIDED|AUTHORIZED)\b/i;

/** A subject code establishes a surface family, not the effect of arbitrary
 * prose. Consume a primary surface heading before an affirmative status; do
 * not search later sentences, construction prose or other facilities for CLSD. */
function proseSurfaceClosure(content: string, subject: string) {
  const text = content.replace(/\s+/g, ' ').trim().toUpperCase();
  const status = /^(.{1,240}?) (?:IS |ARE )?(CLSD|CLOSED)\b(.*)$/.exec(text);
  if (!status || nonAffirmative.test(status[1]!) || quoted.test(status[1]!) || operativePrefix(status[1]!) !== status[1] || withdrawn.test(text)) return;
  const heading = status[1]!, tail = status[3]!;
  const spot = /^SPOT [A-Z0-9-]+$/.test(heading);
  const spotList = '[A-Z0-9-]+(?:, (?:AND )?[A-Z0-9-]+)*';
  const rampScope = `(?:SPOTS? ${spotList}|APRON PARKING ROWS, ${spotList}|` +
    `ALL PARKING SPOTS IN THE (?:[A-Z]+ ){1,3}AREA, [A-Z]+ ROW, AND [A-Z]+ ROW|` +
    `\\d+ RESTRICTED AREA PARKING SPOT [A-Z0-9-]+|A PORTION OF TAXIWAY ${taxiwayId} FROM \\d+ ROW TO \\d+ ROW)`;
  const ramp = new RegExp(`^(?:(?:[A-Z0-9.'-]+ ){1,16})?RAMP(?: (${rampScope}))?$`).exec(heading);
  const taxiway = new RegExp(`^(?:MIL TXL ${taxiwaySegment}|[A-Z .'-]{1,60} (?:AIR|SPACE) FORCE BASE: MIL TAXIWAY BETWEEN (?:TAXIWAY ${taxiwayId}|${endpoint}) AND (?:TAXIWAY ${taxiwayId}|${endpoint}))$`).test(heading);
  if (subject === 'APRON' ? !spot && !ramp : subject !== 'TWY' || !taxiway) return;
  // A taxiway/ramp mentioned before the primary heading cannot become its name.
  if (ramp && /\b(?:RWY|TWY|TAXIWAY|NOTE|REFERENCE|SEE)\b/.test(heading.slice(0, heading.indexOf('RAMP')))) return;
  const partial = !!ramp?.[1] || taxiway && /\bBETWEEN\b/.test(heading);
  if (tail.trim() && tail.trim() !== '.' && !qualifiedClosure.test(tail)) return;
  const qualified = partial || qualifiedClosure.test(tail);
  const label = subject === 'TWY' ? 'Taxiway Closed' : spot ? 'Parking Spot Closed' : 'Ramp Closed';
  return { qualified, label: qualified ? subject === 'TWY' ? 'Taxiway Closure Restriction' : 'Parking Closure Restriction' : label };
}
/** Subject-bound facts; each interpretation keeps the full supporting source span. */
export function notamEffects(content: string, body: string, header: number, subject: string | undefined, targets: NotamTarget[], multipart = false,
  navigation?: NotamNavigation) {
  const facts: NotamFact[] = [];
  let factLimit = false;
  const subjectMatch = /^\s*([A-Z]+)\b/i.exec(content);
  const procedureNotice = ['IAP', 'SID', 'STAR', 'ODP', 'DVA'].includes(subject ?? '');
  function addFact(kind: NotamFactKind, label: string, tone: NotamFlairTone, source: NotamEvidence, scope?: string) {
    if (facts.some(f => f.kind === kind && f.label === label)) return;
    if (facts.length >= MAX_FACTS) { factLimit = true; return; }
    facts.push({ kind, label, tone, evidence: source, ...(scope ? { scope } : {}) });
  }
  function fact(kind: NotamFactKind, label: string, match: RegExpExecArray | null, tone: NotamFlairTone = 'caution', scope?: string) {
    if (match) addFact(kind, label, tone, evidence(body, header + match.index, match[0].length), scope);
  }
  function closure(label: string, match: RegExpExecArray | null) {
    if (!match || nonAffirmative.test(match[0]) || quoted.test(match[0]) || operativePrefix(match[0]) !== match[0] || withdrawn.test(content)) return;
    const tail = content.slice(match.index + match[0].length);
    // A sentence break does not end the closure's aircraft/operating exception.
    const qualified = qualifiedClosure.test(tail);
    addFact(qualified ? 'closure-restriction' : 'closure', qualified ? label.replace('Closed', 'Closure Restriction') : label, qualified ? 'caution' : 'danger',
      evidence(body, header + match.index, match[0].length + (qualified ? tail.length : 0)),
      subject === 'RWY' && runway ? `RWY ${runway[1]!.toUpperCase()}`
        : /^\s*TWY [A-Z0-9/]+ CLSD\b/i.test(match[0]) ? match[0].trim().replace(/ CLSD$/i, '').toUpperCase() : undefined);
  }
  if (subject && subjectMatch) addFact('subject', subjects[subject]!, procedureNotice ? 'procedure' : 'info',
    evidence(body, header + subjectMatch.index,
      subjectMatch[1]!.toUpperCase() === subject ? subjectMatch[0].length : content.length - subjectMatch.index));
  for (const target of targets) addFact('procedure', target.title, 'procedure', target.evidence);
  const runway = subject === 'RWY' ? /^\s*RWY\s*(\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?)(?=\s)/i.exec(content) : null;
  if (runway) fact('runway', `RWY ${runway[1]!.toUpperCase()}`, runway, 'info');
  if (subject === 'RWY') {
    closure('Runway Closed', /^\s*RWY\s+\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?\s+CLSD\b/i.exec(content));
    closure('Runway Segment Closed', partialRunwayClosure.exec(content));
    const lights = /^\s*RWY\s+\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?\s+(RWY\s+END\s+ID\s+LGT|(?:EDGE\s+)?LGT|RAI\s+LGT|ALS|MALSR|MALSF|ALSF-[12]|ODALS|HIRL|MIRL|REIL|PAPI|VASI)\s+U\/S\b/i.exec(content);
    if (lights) {
      const name = lights[1]!.toUpperCase().replace(/\s+/g, ' ');
      const label = name === 'ALS' ? 'Approach Lights Unavailable' : name === 'RAI LGT' ? 'RAI Lights Unavailable'
        : ['PAPI', 'VASI', 'MALSR', 'MALSF', 'ALSF-1', 'ALSF-2', 'ODALS'].includes(name) ? `${name} Unavailable` : 'Lighting Unavailable';
      fact('outage', label, lights, 'caution', runway ? `RWY ${runway[1]!.toUpperCase()}` : undefined);
    }
  }
  if (subject === 'TWY') {
    const taxiway = /^\s*TWY\s+([A-Z0-9]+(?:\/[A-Z0-9]+)*)\b/i.exec(content);
    if (taxiway) fact('taxiway', `TWY ${taxiway[1]!.toUpperCase()}`, taxiway, 'info');
    // Named endpoints must not consume a negation, quoted instruction or condition.
    if (!/\b(?:NOT|IF|WHEN|UNLESS|NOTE|EXC|EXCEPT|DISREGARD|DELETE|READS?)\b/i.test(content.split(/\bCLSD\b/, 1)[0]!)) {
      closure('Taxiway Closed', taxiwayClosure.exec(content));
    }
  }
  if (subject === 'APRON') {
    closure('Taxilane Closed', /^\s*APRON\s+(?:[A-Z0-9]+\s+){0,4}TXL\s+BTN\s+TWY\s+[A-Z0-9]+\s+AND\s+TWY\s+[A-Z0-9]+\s+CLSD\b/i.exec(content));
    const area = `(?:${namedArea}|RAMP \\d+(?: ACCESS)?|(?:[A-Z0-9]+ ){0,3}RUNUP PAD|[A-Z][A-Z0-9]{0,3})`;
    closure('Apron Closed', new RegExp(`^\\s*APRON(?: ${area})? CLSD\\b`, 'i').exec(content));
  }
  if (subject === 'AD') closure('Airport Closed', /^\s*AD\s+AP\s+CLSD\b/i.exec(content));
  // RVR sensor status is separate from a visibility minimum or runway closure.
  // Require the whole status statement so a qualification cannot be discarded.
  if (subject === 'AD' || subject === 'RWY') {
    const rvr = new RegExp(`^\\s*(?:AD AP|RWY (${runwayId})) (RVR[TRM]?)( ALL)? U/S\\.?(?: \\d{10}-(?:\\d{10}(?:EST)?|PERM))?\\s*$`, 'i').exec(content);
    if (rvr && (subject === 'RWY') === Boolean(rvr[1])) {
      fact('outage', `${rvr[3] ? 'All ' : ''}${rvr[2]!.toUpperCase()} Unavailable`, rvr, 'caution',
        rvr[1] ? `RWY ${rvr[1].toUpperCase()}` : undefined);
    }
  }
  let facilityTarget: ParsedNotam['facilityTarget'];
  let categoryTarget: ParsedNotam['categoryTarget'];
  if (subject === 'NAV') {
    const restriction = /^\s*NAV ILS RWY (\d{1,2}[LRC]?) ((?:SPECIAL AUTH |SA )?CAT (?:I|II|III)(?:\/(?:I|II|III))?) NA\b/i.exec(content);
    if (restriction) {
      const title = `ILS RWY ${restriction[1]} ${restriction[2]!.replace(/SPECIAL AUTH /i, 'SA ')}`;
      const category = approachTitleIdentity(title)?.categories[0];
      if (category) {
        categoryTarget = { runway: normalizeRunway(restriction[1]!), ...category };
        fact('restriction', `${restriction[2]} Not Authorized`, restriction, 'caution', `RWY ${restriction[1]}`);
      }
    }
    if (navigation) {
      const { facility: base, components, runway: navRunway, effect, qualification, evidence: source } = navigation;
      const facility = components.length ? base === 'ILS' && components.length === 1 && ['DME', 'OM', 'IM', 'MM', 'LOM'].includes(components[0]!)
        ? `ILS ${components[0]}` : components.join('/') : base;
      if (navRunway) {
        addFact('runway', `RWY ${navRunway}`, 'info', source);
        facilityTarget = { facility, runway: normalizeRunway(navRunway), effect: navigation.sourceEffect === 'NOT MNT' ? 'unmonitored' : 'unavailable',
          ...(navigation.variant ? { variant: navigation.variant } : {}),
          ...(effect === 'restricted' && qualification ? { qualification } : {}) };
      }
      const label = effect === 'unmonitored' ? 'Unmonitored' : effect === 'decommissioned' ? 'Decommissioned'
        : effect === 'restricted' ? 'Restriction' : 'Unavailable';
      const named = qualification?.startsWith('GND REC CHECKPOINT') ? `${facility} Ground Checkpoint` : facility;
      addFact(effect === 'unmonitored' ? 'monitoring' : effect === 'restricted' ? 'restriction' : 'outage',
        `${named} ${label}`, 'caution', source, navRunway ? `RWY ${navRunway}` : undefined);
    }
  }
  if (subject === 'COM' || subject === 'SVC') {
    const service = /^(?:COM|SVC) (ATIS|AUTOMATED WX BCST SYSTEM|TAR\/SSR|TAR|SSR|SMR|MBST\/WS DETECTION SYSTEM|CPDLC|REMOTE COM OUTLET|REMOTE TRANS\/REC|GND COM OUTLET|VOR VOICE|PCL ALL)(?: (\d{2,3}\.\d{1,3}(?:, \d{2,3}\.\d{1,3})*))? (U\/S|NOT AVBL|UNAVBL)\b/.exec(content);
    if (service) {
      const tail = content.slice(service[0].length);
      const qualified = /\b(?:EXC|EXCEPT|ONLY|WHEN|UNLESS|NOT)\b/.test(tail);
      addFact(qualified ? 'restriction' : 'outage', `${service[1]} ${qualified ? 'Restriction' : 'Unavailable'}`, 'caution', evidence(body, header, content.length));
    }
    closure('Tower Closed', /^SVC TWR CLSD\b/.exec(content));
  }
  if (subject === 'OBST') {
    const operative = operativePrefix(content).length === content.length && !/\b(?:NOT|ONLY)\b/i.test(content);
    const lights = /^\s*(?:OBST\s+)?(?:TOWERS?|POLES?|CRANES?|STACKS?|BLDGS?|BUILDINGS?|WIND TURBINES?|WINDMILLS?|RIGS?|TREES?)\s+LGT\b/i.exec(content);
    if (lights) {
      const outage = /\sU\/S(?:\s+\d{10}-\d{10}(?:EST)?)?\s*\.?\s*$/i.exec(content);
      if (outage && operative) addFact('outage', 'Obstacle Light Outage', 'caution', evidence(body, header, outage.index + outage[0].length));
      else fact('obstacle-lighting', 'Obstacle Lighting', lights, 'info');
    }
    fact('obstacle-kind', 'Crane', /^\s*(?:OBST\s+)?CRANE\b/i.exec(content));
    if (operative) {
      fact('obstacle-marking', 'Flagged and Lighted', /\bFLAGGED\s+AND\s+LGTD\b/i.exec(content), 'neutral');
    }
  }
  if (subject === 'AIRSPACE') {
    fact('activity', 'UAS Activity', /^\s*AIRSPACE\s+UAS\b/i.exec(content));
    fact('activity', 'Parachute Activity', /^\s*AIRSPACE\s+PJE\b/i.exec(content));
    const height = /^\s*AIRSPACE\s+UAS\b[^\n;]*?\bSFC-(\d{1,5})\s*FT\s+AGL\b/i.exec(content);
    if (height) fact('altitude', `Surface to ${height[1]} ft AGL`, height, 'neutral');
  }
  // Military prose often supplies a named ramp or aerodrome envelope instead
  // of a domestic keyword. Keep the whole operating qualification as evidence;
  // a parking/aircraft restriction must never imply closure of the airport.
  const operative = operativePrefix(content), source = evidence(body, header, content.length);
  const proseSubject = subject && !new RegExp(`^\\s*${subject}\\b`, 'i').test(content);
  const addOperation = (kind: NotamFactKind, label: string, tone: NotamFlairTone = 'caution') => addFact(kind, label, tone, source);
  if (proseSubject && ['APRON', 'TWY'].includes(subject ?? '') && !facts.some(f => ['closure', 'closure-restriction'].includes(f.kind))) {
    const closure = proseSurfaceClosure(content, subject!);
    if (closure) addOperation(closure.qualified ? 'closure-restriction' : 'closure', closure.label, closure.qualified ? 'caution' : 'danger');
  }
  if (proseSubject && ['APRON', 'AD', 'SVC', 'TWY'].includes(subject ?? '') && /\bARFF\b/.test(operative)) addOperation('restriction', 'ARFF Restriction');
  if (proseSubject && ['APRON', 'AD', 'SVC', 'COM'].includes(subject ?? '') && /\bOPERATING HOURS\b/.test(operative)) addOperation('restriction', 'Operating Hours');
  if (proseSubject && ['APRON', 'AD', 'SVC', 'TWY'].includes(subject ?? '') &&
    /\b(?:MUST|REQUIRED|RESTRICTED|PROHIBITED|PPR)\b|\bNOT AUTHORIZED\b|\bNO (?:PRACTICE|RON|LOX)\b/.test(operative)) {
    addOperation('restriction', subject === 'APRON' ? 'Parking Restriction' : 'Operating Restriction');
  }
  if (proseSubject && ['APRON', 'TWY', 'OBST'].includes(subject ?? '') &&
    /\b(?:WORK IN PROGRESS|WIP|CONSTRUCTION|CONST|OPEN TRENCH|MEN AND EQUIPMENT)\b/.test(operative)) addOperation('activity', 'Construction Activity');
  if (proseSubject && ['APRON', 'TWY', 'OBST'].includes(subject ?? '') && /\b(?:LIGHTS?|LTS?|LGT)\b/.test(operative) &&
    /\b(?:OTS|UNSERVICEABLE|OUTAGE)\b|\bU\/S\b/.test(operative) &&
    !nonAffirmative.test(content) && !/\b(?:ONLY|DLY|MON|TUE|WED|THU|FRI|SAT|SUN)\b/.test(content) &&
    operative.length === content.length) addOperation('outage', 'Obstacle Light Outage');
  if (proseSubject && subject === 'AIRSPACE' && !facts.some(f => f.kind === 'activity')) {
    if (/\b(?:UAS|UNMANNED ACFT)\b/.test(operative)) addOperation('activity', 'UAS Activity');
    else if (/\bMIL ACFT (?:OPS|TRNS)\b/.test(operative)) addOperation('activity', 'Military Aircraft Activity');
    else if (/\b(?:EOD OPERATIONS|VERTICAL HAZARD)\b/.test(operative)) addOperation('activity', 'Hazardous Activity');
  }
  if (procedureNotice) {
    // Quoted/deleted/conditional values are not evidence of an operative minimum.
    const numericContent = multipart ? '' : operativePrefix(content);
    fact('minima', 'Minima Amended', /\b(?:DA|MDAS?)\s+\d+(?:\/|\b)/i.exec(numericContent));
    fact('visibility', 'Visibility Amended', /\b(?:VIS(?:IBILITY)?\s+(?:(?:ALL\s+)?CATS?\s+[A-D/ ]{0,16})?(?:RVR\s+)?\d|RVR\s+\d)/i.exec(numericContent));
    fact('sidestep', 'Sidestep Minima', /\bSIDESTEP\s+\d{1,2}[LRC]?\s+MDA\s+\d+/i.exec(numericContent));
    fact('circling', 'Circling Minima', /\bCIRCLING\s+CAT\s+[A-D]\s+MDA\s+\d+/i.exec(numericContent));
    fact('vdp', 'VDP Amended', /\bVDP\s+(?:AT\s+)?\d+(?:\.\d+)?NM\b/i.exec(numericContent));
    fact('takeoff', 'Takeoff Minima Amended', /\bTAKE-?OFF\s+MINIMUMS\s*:?\s*RWY\s+\d{1,2}[LRC]?\s*,\s*\d/i.exec(numericContent));
    fact('climb', 'Climb Gradient', /\b(?:MINIMUM\s+)?CLIMB\s+OF\s+\d+\s*(?:FT|FEET)(?:\/|\s+PER\s+)NM\b/i.exec(numericContent));
    fact('obstacle-kind', 'Crane', /\bTEMP(?:ORARY)?\s+CRANES?\b/i.exec(content));
    fact('lighting-note', 'Inoperative Lighting Note', /\bFOR\s+INOP\s+(?:ALS|MALSR|MALSF|ALSF-[12]|REIL)\b/i.exec(content));
    fact('restriction', 'Terminal Route Unavailable', /\bTERMINAL\s+ROUTE:\s*FROM\s+[A-Z0-9]+(?:\s*\([A-Z]+\))?\s+TO\s+[A-Z0-9]+(?:\s*\([A-Z]+\))?\s+NA\b/i.exec(numericContent));
    if (subject === 'IAP') fact('restriction', 'Circling Restriction', /\bCIRCLING\s+(?:TO\s+[A-Z0-9 ,/]{1,60}\s+)?NA\b/i.exec(numericContent));
    if (subject === 'SID' || subject === 'STAR') fact('restriction', 'Transition Restriction', /\b[A-Z0-9]+\s+TRANSITION\s+NA\b/i.exec(numericContent));
  }
  const reference = /\bSEE\s+((?:[A-Z0-9]{2,5}\s+)?\d+\/\d+)\b/i.exec(content);
  if (reference) fact('reference', `See NOTAM ${reference[1]!.replace(/\s+/g, ' ')}`, reference, 'neutral');
  return { facts, factLimit, facilityTarget, categoryTarget, runwayTargets: runway?.[1]?.split('/').map(normalizeRunway) ?? [] };
}
