import { evidence, subjects, normalizeRunway, type NotamTarget, type NotamFact, type NotamFactKind, type NotamFlairTone, type NotamEvidence, type ParsedNotam } from './interpretation';
import { operativePrefix } from './clauses';

const MAX_FACTS = 20;
const runwayId = '(?:0?[1-9]|[12]\\d|3[0-6])[LRCU]?';
const runwayPair = `${runwayId}(?:/${runwayId})?`;
const taxiwayId = '[A-Z0-9]+(?:/[A-Z0-9]+)*';
const namedArea = '(?:(?:[A-Z0-9]+ ){0,5}(?:RAMP(?: ACCESS)?|APN|HARDSTAND)|(?:GATE|SPOT) [A-Z0-9]+|DEICE PAD [A-Z0-9]+)';
const endpoint = `(?:(?:APCH END )?RWY ${runwayPair}|(?:TWY|TXL) ${taxiwayId}|${namedArea})`;
const taxiwaySegment = `(?:TWY )?${taxiwayId}(?: BTN ${endpoint} AND ${endpoint})?`;
const taxiwayClosure = new RegExp(`^\\s*TWY ${taxiwaySegment}(?:, ${taxiwaySegment})* CLSD\\b`, 'i');
const partialRunwayClosure = new RegExp(`^\\s*RWY ${runwayPair} (?:[NS][EW]?|[EW]) \\d+\\s*FT CLSD\\b`, 'i');
/** Subject-bound facts; each interpretation keeps the full supporting source span. */
export function notamEffects(content: string, body: string, header: number, subject: string | undefined, targets: NotamTarget[]) {
  const facts: NotamFact[] = [];
  let factLimit = false;
  const subjectMatch = /^\s*([A-Z]+)\b/i.exec(content);
  const procedureNotice = ['IAP', 'SID', 'STAR', 'ODP'].includes(subject ?? '');
  function addFact(kind: NotamFactKind, label: string, tone: NotamFlairTone, source: NotamEvidence, scope?: string) {
    if (facts.some(f => f.kind === kind && f.label === label)) return;
    if (facts.length >= MAX_FACTS) { factLimit = true; return; }
    facts.push({ kind, label, tone, evidence: source, ...(scope ? { scope } : {}) });
  }
  function fact(kind: NotamFactKind, label: string, match: RegExpExecArray | null, tone: NotamFlairTone = 'caution', scope?: string) {
    if (match) addFact(kind, label, tone, evidence(body, header + match.index, match[0].length), scope);
  }
  function closure(label: string, match: RegExpExecArray | null) {
    if (!match) return;
    const tail = content.slice(match.index + match[0].length);
    // A sentence break does not end the closure's aircraft/operating exception.
    const qualified = /^\s+TO\b|\b(?:EXC|EXCEPT|ONLY|WHEN|UNLESS|AUTHORIZED)\b/i.test(tail);
    addFact(qualified ? 'closure-restriction' : 'closure', qualified ? label.replace('Closed', 'Closure Restriction') : label, qualified ? 'caution' : 'danger',
      evidence(body, header + match.index, match[0].length + (qualified ? tail.length : 0)),
      subject === 'RWY' && runway ? `RWY ${runway[1]!.toUpperCase()}`
        : /^\s*TWY [A-Z0-9/]+ CLSD\b/i.test(match[0]) ? match[0].trim().replace(/ CLSD$/i, '').toUpperCase() : undefined);
  }
  if (subject) fact('subject', subjects[subject]!, subjectMatch!, procedureNotice ? 'procedure' : 'info');
  for (const target of targets) addFact('procedure', target.title, 'procedure', target.evidence);
  const runway = subject === 'RWY' ? /^\s*RWY\s+(\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?)(?=\s)/i.exec(content) : null;
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
    closure('Apron Closed', /^\s*APRON\s+(?:[A-Z0-9]+\s+){0,3}CLSD\b/i.exec(content));
  }
  if (subject === 'AD') closure('Airport Closed', /^\s*AD\s+AP\s+CLSD\b/i.exec(content));
  let facilityTarget: ParsedNotam['facilityTarget'];
  if (subject === 'NAV') {
    const aid = /^\s*NAV\s+(ILS|LOC|GP|GS|VOR\/DME|VORTAC|VOR|DME|TACAN|NDB)(?:\s+RWY\s+(\d{1,2}[LRC]?))?(?:\s+(LOC\/GP|LOC\/GS|LOC|GP|GS|DME|OM|IM|MM))?\s+(U\/S|NOT MNT)\b/i.exec(content);
    if (aid && (!aid[3] || aid[1]!.toUpperCase() === 'ILS')) {
      const component = aid[3]?.toUpperCase(), facility = component ?? aid[1]!.toUpperCase();
      // A component suffix is an explicit ILS component, not a VOR/marker alias.
      const effect = aid[4]!.toUpperCase() === 'U/S' ? 'unavailable' : 'unmonitored';
      if (aid[2]) {
        fact('runway', `RWY ${aid[2].toUpperCase()}`, aid, 'info');
        facilityTarget = { facility: component && ['DME', 'OM', 'IM', 'MM'].includes(component) ? `ILS ${component}` : facility,
          runway: normalizeRunway(aid[2]), effect };
      }
      addFact(effect === 'unavailable' ? 'outage' : 'monitoring', `${facilityTarget?.facility ?? facility} ${effect === 'unavailable' ? 'Unavailable' : 'Unmonitored'}`,
        'caution', evidence(body, header + aid.index, content.length - aid.index), aid[2] ? `RWY ${aid[2].toUpperCase()}` : undefined);
    }
  }
  if (subject === 'COM' || subject === 'SVC') {
    const service = /^(?:COM|SVC) (ATIS|AUTOMATED WX BCST SYSTEM|TAR\/SSR|TAR|SSR|SMR|MBST\/WS DETECTION SYSTEM|CPDLC|REMOTE COM OUTLET|REMOTE TRANS\/REC|GND COM OUTLET|VOR VOICE|PCL ALL)(?: (\d{2,3}\.\d{1,3}(?:, \d{2,3}\.\d{1,3})*))? (U\/S|NOT AVBL|UNAVBL)\b/.exec(content);
    if (service) {
      const tail = content.slice(service[0].length);
      const qualified = /\b(?:EXC|EXCEPT|ONLY|WHEN|UNLESS|NOT)\b/.test(tail);
      addFact(qualified ? 'restriction' : 'outage', `${service[1]} ${qualified ? 'Restriction' : 'Unavailable'}`, 'caution', evidence(body, header, content.length));
    }
    fact('closure', 'Tower Closed', /^SVC TWR CLSD\b/.exec(content));
  }
  if (subject === 'OBST') {
    const lights = /^\s*OBST\s+(?:TOWERS?|POLES?|CRANES?|STACKS?|BLDGS?|BUILDINGS?|WIND TURBINES?|WINDMILLS?|RIGS?|TREES?)\s+LGT\b/i.exec(content);
    if (lights) {
      const outage = /\sU\/S(?:\s+\d{10}-\d{10}(?:EST)?)?\s*\.?\s*$/i.exec(content);
      if (outage && !/\b(?:NOT|IF|WHEN|UNLESS|EXC|EXCEPT|DISREGARD|DELETE|NOTE)\b/i.test(content)) addFact('outage', 'Obstacle Light Outage', 'caution', evidence(body, header, outage.index + outage[0].length));
      else fact('obstacle-lighting', 'Obstacle Lighting', lights, 'info');
    }
    fact('obstacle-kind', 'Crane', /^\s*OBST\s+CRANE\b/i.exec(content));
    if (!/\b(?:NOT|IF|WHEN|UNLESS|EXC|EXCEPT|DISREGARD|DELETE|NOTE)\b/i.test(content)) {
      fact('obstacle-marking', 'Flagged and Lighted', /\bFLAGGED\s+AND\s+LGTD\b/i.exec(content), 'neutral');
    }
  }
  if (subject === 'AIRSPACE') {
    fact('activity', 'UAS Activity', /^\s*AIRSPACE\s+UAS\b/i.exec(content));
    fact('activity', 'Parachute Activity', /^\s*AIRSPACE\s+PJE\b/i.exec(content));
    const height = /^\s*AIRSPACE\s+UAS\b[^\n;]*?\bSFC-(\d{1,5})\s*FT\s+AGL\b/i.exec(content);
    if (height) fact('altitude', `Surface to ${height[1]} ft AGL`, height, 'neutral');
  }
  if (procedureNotice) {
    // Quoted/deleted/conditional values are not evidence of an operative minimum.
    const numericContent = operativePrefix(content);
    fact('minima', 'Minima Amended', /\b(?:DA|MDA)\s+\d+(?:\/|\b)/i.exec(numericContent));
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
  return { facts, factLimit, facilityTarget, runwayTargets: runway?.[1]?.split('/').map(normalizeRunway) ?? [] };
}
