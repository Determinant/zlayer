import type { NotamBodyBlock } from '../src/layers/notams/presentation';
import type { NotamMinima, NotamMinimumRow } from '../src/layers/notams/minima';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const normalized = (text: string) => text.toUpperCase().replace(/\s+/g,' ').trim().replace(/\.+$/,'');
const category = (text: string) => /^ALL CATS?$/.test(text) ? 'All categories' : text.replace(/^CATS /,'CAT ');
const value = '(?:NA|\\d+-\\d+/\\d+|\\d+ \\d+/\\d+|\\d+/\\d+|\\d+(?:\\.\\d+)?)(?: (?:SM|MILES?))?';
const fields = new RegExp(`\\b(MDA|DA|HAT|HAA|HAS|VISIBILITY|VIS|RVR)([*#]?)\\s*(RVR )?(${value})( RVR)?`,'g');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** Independent field-binding audit, not the extraction grammar. The preservation
 * audit checks all other words; this checks labels, row/category scopes and order. */
function minima(source: string, block: NotamMinima): boolean {
  let text=normalized(source);
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
  const segments=text.split(/, */), rows: NotamMinimumRow[]=[];
  for (const segment of segments) {
    const cats=[...segment.matchAll(/\b(ALL CATS?|CATS? [A-E](?:\/[A-E])*)\b/g)];
    if (cats.length>1) return false;
    const categories=cats[0] ? category(cats[0][1]!) : undefined;
    const content=segment.replace(/\b(?:ALL CATS?|CATS? [A-E](?:\/[A-E])*)\b/g,'').trim();
    if (!content && categories && rows.length===1 && !rows[0]!.categories) { rows[0]!.categories=categories; continue; }
    const triplet=/^(DA|MDA)\/RVR\/(HAT|HAA|HAS)\s+(\d+)\/(\d+)\/(\d+)$/.exec(content);
    let values: NotamMinimumRow['values'];
    if (triplet) values=[{label:triplet[1]!,value:triplet[3]!},{label:'RVR',value:triplet[4]!},{label:triplet[2]!,value:triplet[5]!}];
    else values=[...content.matchAll(fields)].map(m=>({label:`${/^VIS/.test(m[1]!)?'Visibility':m[1]}${m[2]}`,
      value:`${m[3] || m[5] ? 'RVR ' : ''}${m[4]}`}));
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
    const sections=text.split(/, (?=[*#]?(?:LNAV|LPV|LP|GLS|RNP|S-|H-|CIRCLING|SIDESTEP)\b)/);
    return sections.length===block.entries.length && block.entries.every((e,i)=>minima(sections[i]!,e))?[]:['minima procedure-scope binding'];
  }
  if (block.kind==='distances') return block.values.every(v=>new RegExp(`\\b${v.label} ${escape(v.value).replace(' FT','\\s*FT')}\\b`).test(text)) &&
    text.startsWith(`RWY ${block.runway} DECLARED DIST:`)?[]:['runway/distance binding'];
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
