import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isNotamAirportSnapshot, NOTAM_STALE_MS } from '@zlayer/contracts';
import { auditNotam, auditMappedNotam, auditRenderedNotam } from './audit-notams';

export type CaptureEvidence = { capturedAt: number; airports: string[]; generations: string[]; checks: number[];
  healthy: boolean; recordVersions: string[]; errors: string[] };
/** A new download time is never a new source generation. */
export function assessNotamGenerations(captures: CaptureEvidence[]) {
  const problems: string[]=[], fresh: CaptureEvidence[]=[];
  const expected=captures[0]?.airports.slice().sort().join(',');
  for (const [i,capture] of captures.entries()) {
    if (capture.airports.slice().sort().join(',')!==expected) problems.push(`capture ${i+1}: different airport cohort`);
    if (capture.errors.length) problems.push(`capture ${i+1}: ${capture.errors.length} semantic/preservation failures`);
    const current=capture.healthy && capture.generations.length===1 && capture.checks.length>0 &&
      capture.checks.every(t=>Number.isFinite(t) && t<=capture.capturedAt+30_000 && capture.capturedAt-t<NOTAM_STALE_MS);
    if (!current) problems.push(`capture ${i+1}: source is stale, degraded or mixed-generation`);
    else fresh.push(capture);
  }
  const generations=new Set(fresh.flatMap(c=>c.generations));
  if (generations.size<2) problems.push('At least two distinct fresh complete source generations are required');
  const all=new Set<string>();
  const versions=captures.map(c=>{
    const additions=c.recordVersions.filter(v=>!all.has(v)); c.recordVersions.forEach(v=>all.add(v));
    return {capturedAt:new Date(c.capturedAt).toISOString(),generations:c.generations,sourceCheckedAt:c.checks,
      healthy:c.healthy,recordVersions:c.recordVersions.length,newRecordVersions:additions.length,errors:c.errors};
  });
  return {qualified:problems.length===0,freshGenerations:generations.size,distinctRecordVersions:all.size,problems,captures:versions};
}

async function inspect(directory: string): Promise<CaptureEvidence> {
  const capture=JSON.parse(await readFile(join(directory,'capture.json'),'utf8')) as {capturedAt:string};
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')) as {airports:{faaId:string;icaoId:string}[]};
  const records=new Map<string,string>(), generations=new Set<string>(), checks=new Set<number>(), errors:string[]=[];
  let healthy=true;
  for (const airport of manifest.airports) {
    const value:unknown=JSON.parse(await readFile(join(directory,`${airport.icaoId}.json`),'utf8'));
    if (!isNotamAirportSnapshot(value) || value.query.faaId!==airport.faaId || value.query.icaoId!==airport.icaoId) throw new Error(`Invalid ${airport.icaoId}`);
    if (value.feed.generation) generations.add(value.feed.generation);
    checks.add(value.feed.checkedAt ?? NaN);
    healthy &&= value.feed.state==='ready' && value.feed.continuity==='complete' && value.associationCoverage==='complete' &&
      (value.contentCoverage ?? 'complete')==='complete' && !value.issues?.length;
    for (const record of value.records) {
      const version=createHash('sha256').update(JSON.stringify(record)).digest('hex'), old=records.get(record.id);
      if (old && old!==version) errors.push(`${record.id}: changed within capture`);
      if (!old) for(const problem of [...auditNotam(record),...auditMappedNotam(record),...auditRenderedNotam(record),...auditRenderedNotam(record,true)]) errors.push(`${record.id}: ${problem}`);
      records.set(record.id,version);
    }
  }
  return {capturedAt:Date.parse(capture.capturedAt),airports:manifest.airports.map(a=>`${a.faaId}/${a.icaoId}`),
    generations:[...generations].sort(),checks:[...checks].sort(),healthy,recordVersions:[...records].map(([id,hash])=>`${id}:${hash}`),errors};
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [output,...directories]=process.argv.slice(2);
  if (!output || directories.length<2) throw new Error('Usage: node --import=tsx --import=./test/helpers/assets.ts tools/audit-notam-generations.ts REPORT.json CAPTURE_A CAPTURE_B [...]');
  const captures:CaptureEvidence[]=[];
  for(const directory of directories) captures.push(await inspect(directory));
  const result=assessNotamGenerations(captures);
  await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({qualified:result.qualified,freshGenerations:result.freshGenerations,distinctRecordVersions:result.distinctRecordVersions,problems:result.problems},null,2));
  if (!result.qualified) process.exitCode=1;
}
