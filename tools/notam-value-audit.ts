import type { NotamBodyBlock } from '../src/layers/notams/presentation';
import type { NotamMinima, NotamMinimumRow } from '../src/layers/notams/minima';
import type { NotamNavigation } from '../src/layers/notams/navigation-notice';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const normalized = (text: string) => text.toUpperCase().replace(/\s+/g,' ').trim().replace(/\.+$/,'');
const category = (text: string) => /^ALL CATS?$/.test(text) ? 'All categories' : text.replace(/^CATS /,'CAT ');
const value = '(?:NA|\\d+-\\d+/\\d+|\\d+ \\d+/\\d+|\\d+/\\d+|\\d+(?:\\.\\d+)?)(?:\\s*(?:SM|MILES?|FT))?';
const fields = new RegExp(`\\b(MDA|DA|RA|HAT|HAA|HAS|VISIBILITY|VIS|RVR|MINIMUMS)\\s*([*#]?)[: ]*(RVR )?(${value})`,'g');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** Validate independently retained navigation field associations, including
 * component order/multiplicity and the distinction between status and coverage. */
export function auditNavigationBindings(source: string, notice: NotamNavigation, associations: readonly string[] = []): string[] {
  const text = normalized(source), issues: string[] = [];
  const facility = notice.facility === 'LDA' ? /\bLOC TYPE DIRECTIONAL AID\b/.exec(text)
    : new RegExp(`\\b${escape(notice.facility)}\\b`).exec(text);
  if (!facility) return ['navigation facility binding'];
  let rest = text.slice(facility.index + facility[0].length).replace(/^ RWY \d{1,2}[LRC]?(?:\([A-Z]\))?/, '');
  const locator = /^ ([A-Z0-9]{2,5}) (?=LOM\b)/.exec(rest);
  if (locator) rest = rest.slice(locator[1]!.length + 1);
  if ((locator?.[1] ?? undefined) !== notice.locator) issues.push('navigation locator binding');
  const token = /^ (\S+)/.exec(rest)?.[1], componentNames = ['LOC', 'GP', 'GS', 'DME', 'OM', 'IM', 'MM', 'LOM', 'BC', 'AZM'];
  const components = rest.startsWith(' OUTER MARKER ') ? ['OM']
    : token && token.split('/').every(component => componentNames.includes(component)) ? token.split('/') : [];
  if (!same(components, notice.components)) issues.push('navigation component binding');
  const runway = /\bRWY (\d{1,2}[LRC]?)(?:\(([A-Z])\))?\b/.exec(text);
  // The final parenthesis is a non-word character, so read its variant directly.
  const variant = /\bRWY \d{1,2}[LRC]?\(([A-Z])\)/.exec(text)?.[1];
  if (runway?.[1] !== notice.runway || variant !== notice.variant) issues.push('navigation runway binding');
  const barePrefix = /^([A-Z0-9]{2,5}) /.exec(text)?.[1];
  const reference = /^\/([A-Z0-9]{2,5})\//.exec(text)?.[1] ??
    (barePrefix && associations.includes(barePrefix) && barePrefix !== notice.facility ? barePrefix : undefined);
  if (reference !== notice.sourceReference) issues.push('navigation source reference binding');
  const prefix = text.slice(0, facility.index).replace(/^\/[A-Z0-9]{2,5}\//, '')
    .replace(reference ? new RegExp(`^${escape(reference)} `) : /$^/, '')
    .replace(/\b(?:NAV|NAVAID)\b/g, '').replace(/\bRWY \d{1,2}[LRC]?\b/g, '').trim();
  if ((prefix || undefined) !== notice.station) issues.push('navigation station binding');
  if (!new RegExp(`(?:^| )${escape(notice.sourceEffect)}(?= |$)`).test(text)) issues.push('navigation source effect binding');
  if (notice.qualification && !text.includes(normalized(notice.qualification))) issues.push('navigation qualification binding');
  const expected = notice.qualification && !notice.qualification.startsWith('GND REC CHECKPOINT') ? 'restricted'
    : notice.sourceEffect === 'NOT MNT' ? 'unmonitored' : notice.sourceEffect === 'DECOMMISSIONED' ? 'decommissioned' : 'unavailable';
  if (notice.effect !== expected) issues.push('navigation effect binding');
  return issues;
}

/** Independent field-binding audit, not the extraction grammar. The preservation
 * audit checks all other words; this checks labels, row/category scopes and order. */
function minima(source: string, block: NotamMinima): boolean {
  let text=normalized(source).replace(/\bMDAS\b/g,'MDA').replace(/\bALLCATS?\b/g,'ALL CATS').replace(/\bCATS?([A-E])\b/g,'CAT $1')
    .replace(/\bVISIBLITY\b/g,'VISIBILITY');
  if (block.context) {
    const context=normalized(block.context); if (!text.startsWith(context)) return false;
    text=text.slice(context.length).replace(/^[: ]+/,'');
  }
  if (!['Minimums','Visibility'].includes(block.scope)) {
    const scope=normalized(block.scope).replace('SIDESTEP RUNWAY ','SIDESTEP ');
    text=text.replace(/^SIDESTEP:? (?:RWY )?/,'SIDESTEP ');
    if (!text.startsWith(scope+' ')) return false;
    text=text.slice(scope.length).trim();
  }
  if (block.condition) {
    const condition=normalized(block.condition); if (!text.endsWith(condition)) return false;
    text=text.slice(0,-condition.length).replace(/[, ]+$/,'');
  }
  const segments=text.split(/[,;] */), rows: NotamMinimumRow[]=[];
  for (const segment of segments) {
    const cats=[...segment.matchAll(/\b(ALL CATS?|CATS? [A-E](?:(?:\s*\/\s*| AND )[A-E])*)\b/g)];
    if (cats.length>1) return false;
    const categories=cats[0] ? category(cats[0][1]!) : undefined;
    const content=segment.replace(/\b(?:ALL CATS?|CATS? [A-E](?:(?:\s*\/\s*| AND )[A-E])*)\b/g,'').trim();
    if (!content && categories && rows.length===1 && !rows[0]!.categories) { rows[0]!.categories=categories; continue; }
    const triplet=/^(DA|MDA)\/RVR\/(HAT|HAA|HAS)\s+(\d+)\/(\d+)\/(\d+)$/.exec(content);
    const pair=/^(DA|MDA)\/(HAT|HAA|HAS)[: ]+(\d+(?:\.\d+)?(?:\s*FT)?)\/(\d+(?:\.\d+)?(?:\s*FT)?)$/.exec(content);
    let values: NotamMinimumRow['values'];
    if (triplet) values=[{label:triplet[1]!,value:triplet[3]!},{label:'RVR',value:triplet[4]!},{label:triplet[2]!,value:triplet[5]!}];
    else if (pair) values=[{label:pair[1]!,value:pair[3]!},{label:pair[2]!,value:pair[4]!}];
    else values=[...content.matchAll(fields)].map(m=>({label:`${/^VIS/.test(m[1]!)?'Visibility':m[1]==='MINIMUMS'?'Minimums':m[1]}${m[2]}`,
      value:`${m[3] || /^VIS/.test(m[1]!) && /^ RVR\b/.test(content.slice(m.index + m[0].length)) ? 'RVR ' : ''}${m[4]}`}));
    if (!values.length && categories && new RegExp(`^${value}$`).test(content) &&
      rows.at(-1)?.values.length===1 && rows.at(-1)!.values[0]!.label==='Visibility' && !rows.at(-1)!.values[0]!.value.startsWith('RVR ')) {
      values=[{label:'Visibility',value:content}];
    }
    if (!values.length) return false;
    rows.push({values,...(categories?{categories}:{})});
  }
  // Property order is irrelevant, but row/field order and every association matter.
  return same(rows,block.rows.map(r=>({values:r.values,...(r.categories?{categories:r.categories}:{})})));
}

export function auditValueBindings(source: string, block: NotamBodyBlock): string[] {
  const text=normalized(source);
  if (block.kind==='minima') return minima(text,block)?[]:['minima field/category binding'];
  if (block.kind==='minima-group') {
    const sections=source.toUpperCase().trim().split(/(?:[,;]\s+|\r?\n\s*)(?=[*#]?(?:LNAV|LPV|LP|GLS|ILS|LOC|RNP|S-|H-|CIRCLING|SIDESTEP)\b)/);
    return sections.length===block.entries.length && block.entries.every((e,i)=>minima(sections[i]!,e))?[]:['minima procedure-scope binding'];
  }
  if (block.kind==='distances') {
    const context=block.runwaySource && /^RWY (\d{1,2}[LRC]?) THR DISPLACED \d+(?:\.\d+)?\s*FT(?: (?:MARKING NOT STD|NONPRECISION MARKING))?$/.exec(normalized(block.runwaySource.text));
    if (block.runwaySource && (!context || context[1]!==block.runway || !/^DECLARED DIST(?:ANCES)?(?::\s*|\s+)/.test(text))) return ['runway context binding'];
    const scoped=context?`RWY ${context[1]} ${text}`:text;
    const heading=/^(?:DECLARED DIST(?:ANCES)?(?::\s*|\s+))?RWY (\d{1,2}[LRC]?)(?::\s*|\s+)(?:DECLARED DIST(?:ANCES)?(?::\s*|\s+))?/.exec(scoped);
    const fields=heading && [...scoped.slice(heading[0].length).matchAll(/\b(TORA|TODA|ASDA|LDA)(?::\s*|\s+)(\d+(?:\.\d+)?)\s*FT\b/g)]
      .map(m=>({label:m[1]!,value:`${m[2]} FT`}));
    return heading?.[1]===block.runway && same(fields,block.values)?[]:['runway/distance binding'];
  }
  if (block.kind==='takeoff-group') {
    const sections=text.replace(/^TAKE-?OFF MINIMUMS: /,'').split(/, (?=(?:JETS|PROPS): )/);
    return sections.length===block.entries.length && block.entries.every((e,i)=>sections[i]!.startsWith(`${e.aircraft?.toUpperCase()}: `) &&
      !auditValueBindings(`TAKEOFF MINIMUMS ${sections[i]!.replace(/^(?:JETS|PROPS): /,'')}`,e).length)?[]:['takeoff aircraft-scope binding'];
  }
  if (block.kind==='takeoff') {
    const heading=new RegExp(`^TAKE-?OFF MINIMUMS:? RWYS? ${escape(block.runway)}[:,] +`);
    if (!heading.test(text)) return ['takeoff runway binding'];
    const branches=text.replace(heading,'').replace(/ \(\d{4}-[^()]+\)$/,'').split(/,? OR /);
    if (branches.length!==block.options.length) return ['takeoff alternative binding'];
    for (const [i,option] of block.options.entries()) {
      const branch=branches[i]!, minimum=normalized(option.minimums).replace('STANDARD MINIMUMS','STANDARD').replace('NOT AUTHORIZED','NA');
      if (!(branch.replace(/^STD\b/,'STANDARD')===minimum || branch.replace(/^STD\b/,'STANDARD').startsWith(minimum+' '))) return ['takeoff minimum binding'];
      const climbs=[...branch.matchAll(/(\d+(?:\.\d+)?)\s*(?:FT\/NM|FT PER NM|FEET PER NM) TO (\d+)/g)].map(m=>({gradient:m[1],altitude:m[2]}));
      if (!same(climbs,[...(option.climb?[option.climb]:[]),...(option.then??[])])) return ['takeoff climb-stage binding'];
    }
  }
  return [];
}
