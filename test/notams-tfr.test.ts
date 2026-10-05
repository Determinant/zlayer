import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTfrSnapshot, TFR_REFRESH_MS, type TfrSnapshot } from '@zlayer/contracts';
import corpus from './fixtures/tfrs.json' with { type: 'json' };
import { parseTfrDetail, parseTfrIndex } from '../tools/info-server/notams/tfr-normalize';
import { createTfrService } from '../tools/info-server/notams/tfr-service';
import { createInfoServer } from '../tools/info-server/server';
import { tfrTiming } from '../src/layers/notams/tfr-time';
import { tfrFeatures } from '../src/layers/notams/tfr-map';
import { createTfrClient } from '../src/layers/notams/tfr-client';
import { selectedTfrAreas } from '../src/layers/notams/tfr-selection';

const at = Date.parse;
const examples = corpus.cases.map(c => parseTfrDetail(c.xml,parseTfrIndex([c.index])[0]!));
const snapshot = (): TfrSnapshot => ({ schemaVersion: 1, source: 'FAA-TFR', checkedAt: at('2026-10-05T21:00Z'), notices: structuredClone(examples) });

test('FAA TFR source identity, UTC times, altitude datums and merged geometry are retained', () => {
  const fire = examples[0]!, sf = examples[1]!;
  assert.equal(fire.id,'6/6654'); assert.equal(fire.startsAt,at('2026-10-01T16:00Z'));
  assert.equal(fire.areas[0]!.upper,'10000 ft MSL'); assert.equal(fire.areas[0]!.lower,'SFC');
  assert.deepEqual(fire.areas[0]!.geometry!.coordinates[0]![0],[-120.83333333,48.3999651]);
  assert.equal(sf.startsAt,at('2026-10-08T17:00Z'),'PDT is a display zone, not an offset for the XML UTC date');
  assert.equal(sf.areas[0]!.upper,'3000 ft AGL');
  assert.ok(isTfrSnapshot(snapshot()));
  for (const [bad, entry] of [[corpus.cases[0]!.xml, parseTfrIndex([corpus.cases[1]!.index])[0]!],
    [corpus.cases[0]!.xml.replace('2026-10-01T16:00:00','2026-10-01T17:00:00'),parseTfrIndex([corpus.cases[0]!.index])[0]!]] as const) {
    assert.throws(() => parseTfrDetail(bad,entry));
  }
  assert.throws(() => parseTfrIndex([corpus.cases[0]!.index,corpus.cases[0]!.index]));
  const excluded = parseTfrDetail(corpus.cases[0]!.xml.replace('<codeExclVerLower>INCLUDE</codeExclVerLower>',
    '<codeExclVerLower>EXCLUDE</codeExclVerLower>'),parseTfrIndex([corpus.cases[0]!.index])[0]!);
  assert.equal(excluded.areas[0]!.lower,'Excluding SFC');
});

test('daily overnight and weekday schedules transition at the published boundaries', () => {
  const fire = examples[0]!, area = fire.areas[0]!;
  for (const [time,status] of [['2026-10-01T15:59Z','upcoming'],['2026-10-01T16:00Z','active'],
    ['2026-10-02T01:59Z','active'],['2026-10-02T02:00Z','upcoming'],['2026-10-15T02:00Z',undefined]] as const) {
    assert.equal(tfrTiming(fire,area,at(time))?.status,status,time);
  }
  assert.equal(tfrTiming(fire,area,at('2026-10-02T02:00Z'))?.startsAt,at('2026-10-02T16:00Z'));
  const weekly = examples[2]!, e = weekly.areas.find(a => a.name === 'Area E')!;
  assert.equal(tfrTiming(weekly,e,at('2026-10-06T10:00Z'))?.status,'active');
  assert.equal(tfrTiming(weekly,e,at('2026-10-07T10:00Z'))?.startsAt,at('2026-10-08T10:00Z'));
});

test('TFR great-circle boundaries stay local across the date line and invalid schedules fail validation', () => {
  const fixture = corpus.cases[0]!;
  const points = [[179,51],[-179,51],[-179,52],[179,52],[179,51]];
  const boundary = `<abdMergedArea>${points.map(([lon,lat]) => `<Avx><codeDatum>WGE</codeDatum><codeType>GRC</codeType><geoLat>${lat}N</geoLat><geoLong>${Math.abs(lon!)}${lon!<0?'W':'E'}</geoLong></Avx>`).join('')}</abdMergedArea>`;
  const notice = parseTfrDetail(fixture.xml.replace(/<abdMergedArea>[\s\S]*?<\/abdMergedArea>/,boundary),parseTfrIndex([fixture.index])[0]!);
  const ring = notice.areas[0]!.geometry!.coordinates[0]!;
  assert.ok(ring.length > points.length, 'long great-circle edges are densified');
  assert.ok(ring.every(p=>p[0]>=179 && p[0]<=181));
  assert.deepEqual(ring[0],ring.at(-1));
  const data = snapshot(); data.notices[0]!.areas[0]!.windows![0]!.startsAt = 0;
  assert.equal(isTfrSnapshot(data),false,'area validity cannot exceed its notice');
});

test('missing XML dates use the exact raw validity; missing shapes and unknown schedules stay explicit', () => {
  assert.equal(examples[3]!.startsAt,at('2026-01-05T16:17Z'));
  assert.equal(examples[4]!.endsAt,null);
  const entry = parseTfrIndex([corpus.cases[0]!.index])[0]!;
  const unknown = parseTfrDetail(corpus.cases[0]!.xml.replace('<dayCode>Daily</dayCode>','<dayCode>Unrecognized</dayCode>'),entry);
  assert.equal(unknown.areas[0]!.windows,null);
  assert.equal(tfrTiming(unknown,unknown.areas[0]!,at('2026-10-05T21:00Z'))?.status,'unknown');
  const points = parseTfrDetail(corpus.cases[0]!.xml.replace('<codeType>GRC</codeType>','<codeType>ARC</codeType>'),entry);
  assert.equal(points.areas[0]!.geometry,null);
});

test('national chart features use red for active, yellow for next activation and omit expired areas', () => {
  const data = snapshot(), features = tfrFeatures({ snapshot: data, now: data.checkedAt, loading: false }).features;
  assert.equal(features.find(f => f.properties.noticeId === '6/6654')!.properties.color,'#ff4d55');
  assert.equal(features.find(f => f.properties.noticeId === '6/7455')!.properties.color,'#ffd54a');
  const missing = structuredClone(data); missing.notices.forEach(n => n.areas.forEach(a => { a.geometry = null; }));
  assert.equal(tfrFeatures({ snapshot: missing, now: data.checkedAt, loading: false }).features.length,0);
  assert.ok(!tfrFeatures({ snapshot: data, now: at('2026-10-15T02:00Z'), loading: false }).features.some(f => f.properties.noticeId === '6/6654'));
  assert.deepEqual(tfrFeatures({ snapshot: data, now: data.checkedAt, loading: false, error: 'Refresh failed' }).features, features,
    'freshness is shown in details/footer without adding map labels or replacing geometry');
});

test('TFR inspection resolves overlapping selections once against current source revisions and time', () => {
  const data = snapshot(), notice = data.notices[0]!, area = notice.areas[0]!;
  const selected = [{ noticeId: notice.id, areaId: area.id }, { noticeId: notice.id, areaId: area.id },
    { noticeId: data.notices[1]!.id, areaId: data.notices[1]!.areas[0]!.id }];
  const state = { snapshot: data, now: data.checkedAt, loading: false };
  assert.deepEqual(selectedTfrAreas(state, selected).map(a => a.timing.status), ['active', 'upcoming']);
  notice.text = 'Updated source text';
  assert.equal(selectedTfrAreas(state, selected)[0]!.notice.text, 'Updated source text');
  assert.equal(selectedTfrAreas({ ...state, now: at('2027-01-01T00:00Z') }, selected).length, 0);
  data.notices = [];
  assert.equal(selectedTfrAreas(state, selected).length, 0);
});

test('background TFR collection reuses unchanged details, retains failures, restores and removes absent notices', async t => {
  const directory = await mkdtemp(join(tmpdir(),'zlayer-tfr-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const controller = new AbortController(); t.after(()=>controller.abort());
  let time = at('2026-10-05T21:00Z'), fail = false, index = corpus.cases.slice(0,2).map(c=>c.index), details = 0;
  const fetcher = (async (url: string) => {
    if (fail) return new Response('unavailable',{status:502});
    if (url.endsWith('getTfrList')) return Response.json(index);
    details++; const c = corpus.cases.find(c=>url.includes(c.index.notam_id.replace('/','_')))!;
    return new Response(c.xml);
  }) as typeof fetch;
  const options = {directory,signal:controller.signal,now:()=>time,fetch:fetcher,wait:async(ms:number)=>{time+=ms;}};
  const service = createTfrService(options); await service.restore(); await service.refresh();
  assert.equal(service.read()!.notices.length,2); assert.equal(details,2);
  time+=TFR_REFRESH_MS; await service.refresh(); assert.equal(details,2);
  const checked = service.read()!.checkedAt; fail=true; time+=TFR_REFRESH_MS; await service.refresh();
  assert.equal(service.read()!.checkedAt,checked); assert.equal(service.read()!.error,'refresh-failed');
  await service.close();
  const restored = createTfrService(options); t.after(()=>restored.close()); await restored.restore(); assert.equal(restored.read()!.notices.length,2);
  fail=false; index=[]; time+=TFR_REFRESH_MS; await restored.refresh(); assert.equal(restored.read()!.notices.length,0);
});

test('TFR HTTP reads only published snapshots and never acquire FAA data', async t => {
  const directory = await mkdtemp(join(tmpdir(),'zlayer-tfr-http-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  let reads=0;
  const app=await createInfoServer({directory,startUpdates:false,spacing:0,fetch:(async()=>{reads++;return Response.json([]);}) as typeof fetch});
  t.after(()=>app.close()); await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const addr=app.server.address(); assert.ok(addr&&typeof addr==='object'); const url=`http://127.0.0.1:${addr.port}/api/notams/tfrs`;
  assert.equal((await fetch(url)).status,503); assert.equal(reads,0);
  await app.tfrs.refresh(); assert.equal(reads,1);
  assert.ok(isTfrSnapshot(await (await fetch(url)).json())); assert.equal((await fetch(url,{method:'HEAD'})).status,200);
  assert.equal(reads,1); assert.equal((await fetch(url+'?refresh=true')).status,404);
  const health = await (await fetch(url.replace('/notams/tfrs','/weather/healthz'))).json();
  assert.equal(health.tfrs.ready,true); assert.equal(reads,1);
});

test('TFR demand persists without airport readers and late reads cannot survive disable', async t => {
  let finish!: (s:TfrSnapshot)=>void, writes=0, calls=0;
  const client=createTfrClient({now:()=>at('2026-10-05T21:00Z'),debounceMs:0,storage:{read:()=>null,write:()=>{writes++;}},
    load:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  t.after(()=>client.stop()); client.start(); await new Promise(r=>setTimeout(r,10));
  assert.equal(calls,1); client.stop(); finish(snapshot()); await new Promise(r=>setImmediate(r));
  assert.equal(client.state.getSnapshot().snapshot,undefined); assert.equal(writes,0);
  client.start(); await new Promise(r=>setTimeout(r,10)); finish(snapshot()); await new Promise(r=>setImmediate(r));
  assert.equal(client.state.getSnapshot().snapshot?.notices.length,6); assert.equal(writes,1);
});

test('the live clock changes TFR colors at activation and removes expired areas without another request', async t => {
  const data=snapshot(), now=data.checkedAt;
  data.notices=data.notices.slice(0,1);
  const notice=data.notices[0]!; notice.startsAt=now+1000; notice.endsAt=now+5000;
  notice.areas=notice.areas.slice(0,1); notice.areas[0]!.windows=[{startsAt:notice.startsAt,endsAt:notice.endsAt}];
  t.mock.timers.enable({apis:['Date','setTimeout'],now});
  let requests=0;
  const client=createTfrClient({debounceMs:0,storage:{read:()=>data,write(){}},load:async()=>{requests++;return data;}});
  t.after(()=>client.stop()); client.start();
  t.mock.timers.tick(0); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(tfrFeatures(client.state.getSnapshot()).features[0]!.properties.status,'upcoming');
  t.mock.timers.tick(1000);
  assert.equal(tfrFeatures(client.state.getSnapshot()).features[0]!.properties.status,'active');
  t.mock.timers.tick(4000);
  assert.equal(tfrFeatures(client.state.getSnapshot()).features.length,0); assert.equal(requests,1);
});
