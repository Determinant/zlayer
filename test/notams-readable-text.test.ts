import assert from 'node:assert/strict';
import test from 'node:test';
import { readableNotamText } from '../src/layers/notams/readable-text';
import { presentNotam } from '../src/layers/notams/presentation';
import { notice } from './fixtures/notams';

test('ordinary notice prose uses sentence case without changing aviation codes or values', () => {
  for (const [source, expected] of [
    ['DME REQUIRED EXCEPT FOR ACFT EQUIPPED WITH SUITABLE RNAV SYSTEM WITH GPS, UBG VOR OUT OF SERVICE.',
      'DME required except for ACFT equipped with suitable RNAV system with GPS, UBG VOR out of service.'],
    ['TWY B4 SFC PAINTED HLDG PSN SIGNS EAST SIDE NOT STD', 'TWY B4 SFC painted HLDG PSN signs east side not STD'],
    ['RVR 1800 AUTHORIZED WITH USE OF FD OR AP OR HUD TO DA.', 'RVR 1800 authorized with use of FD or AP or HUD to DA.'],
    ['APRON C5 RUNUP PAD CLSD EXC ACFT FACING W. WORK IN PROGRESS.', 'Apron C5 runup pad CLSD EXC ACFT facing W. Work in progress.'],
    ['TAKE-OFF MINIMUMS RWY 13, STANDARD WITH MINIMUM CLIMB OF 412 FT/MIN TO 3500 MSL.',
      'Take-off minimums RWY 13, standard with minimum climb of 412 FT/MIN to 3500 MSL.'],
  ]) {
    const result = readableNotamText(source!);
    assert.equal(result, expected);
    assert.equal(result.toUpperCase(), source, 'casing never paraphrases or drops a qualifier');
  }
});

test('English-word fixes and navaids stay uppercase without capitalizing ordinary uses of the same word', () => {
  assert.equal(readableNotamText('CLIMB TO 520 THEN DIRECT CROSS AND ON TRACK 015 TO WHITE, CROSS WHITE AT 2000 AND HOLD.'),
    'Climb to 520 then direct CROSS and on track 015 to WHITE, cross WHITE at 2000 and hold.');
  assert.equal(readableNotamText('WHITE FIX MINIMUMS (DME REQUIRED). DIRECT HOLD AND HOLD AT WHITE INT. WHITE MARKINGS FADED.'),
    'WHITE fix minimums (DME required). Direct HOLD and hold at WHITE INT. White markings faded.');
  assert.equal(readableNotamText('CROSS VOR/DME OUT OF SERVICE. WHITE TRANSITION NA. RADAR DEPARTURE NA.'),
    'CROSS VOR/DME out of service. WHITE transition NA. Radar departure NA.');
  assert.equal(readableNotamText('NAV SEA OUT OF SERVICE. NEW RESTRICTION AT ALL.', ['SEA', 'ALL']),
    'NAV SEA out of service. New restriction at ALL.');
  assert.equal(readableNotamText('TWY ON CLSD. TURN TO POINT OF ORIGIN.'), 'TWY ON CLSD. Turn to point of origin.');
  assert.equal(readableNotamText('CLIMB DIRECT\nWHITE THEN DIRECT BELOW; HOLD BELOW 3000. WHITE\nVOR U/S.'),
    'Climb direct\nWHITE then direct BELOW; hold below 3000. WHITE\nVOR U/S.');
});

test('coordinates, references, minima notation, unknown tokens and mixed-case source spelling survive', () => {
  const source = 'OBST TOWER LGT (ASR 1031666) 393049.30N1044721.20W (4.4NM SE APA) 6027.9FT (108.9FT AGL) U/S.\n' +
    'TEMPORARY CRANE (2020-ASW-6805-NRA), MDA 880/HAT460, RNP .15, VIS 1-1/2, CAT II/III. WHITE-123 HOLD.ONE.\n' +
    'UNRECOGNIZED ABCDEF; McClellan FIELD.';
  const result = readableNotamText(source);
  assert.equal(result.toUpperCase(), source.toUpperCase());
  for (const token of ['393049.30N1044721.20W', '4.4NM SE APA', '6027.9FT', '108.9FT AGL', '2020-ASW-6805-NRA',
    'MDA 880/HAT460', 'RNP .15', 'VIS 1-1/2', 'CAT II/III', 'WHITE-123 HOLD.ONE', 'UNRECOGNIZED ABCDEF', 'McClellan']) {
    assert.ok(result.includes(token), token);
  }
});

test('sentence casing respects decimals, wrapped lines, sentence boundaries and existing mixed case', () => {
  assert.equal(readableNotamText('TEMPORARY CRANES UP TO 320.5 MSL;\nEXCEPT WHEN ADVISED BY ATCT THAT THIS CRANE IS DOWN.\nALL OTHER DATA REMAINS AS PUBLISHED.'),
    'Temporary cranes up to 320.5 MSL;\nexcept when advised by ATCT that this crane is down.\nAll other data remains as published.');
  assert.equal(readableNotamText('Climb to 2000 DIRECT WHITE. Do not change published names.'),
    'Climb to 2000 direct WHITE. Do not change published names.');
});

test('airport context, minima conditions and fallback prose share readable casing while raw stays exact', () => {
  const record = notice({ classification: 'FDC', text: 'IAP SAN FRANCISCO INTL, SAN FRANCISCO, CA.\n' +
    'WHITE FIX MINIMUMS (DME REQUIRED): LNAV MDA 880/HAT 460 ALL CATS, UNLESS ADVISED BY ATC THAT CRANES ARE DOWN.\n' +
    'TEMPORARY CRANES BEGINNING 4978FT FROM DER, 1555FT LEFT OF CENTERLINE.' });
  const before = structuredClone(record);
  const blocks = presentNotam(record).blocks;
  assert.deepEqual(blocks[0], { kind: 'context', text: 'IAP · San Francisco INTL, San Francisco, CA' });
  const minima = blocks[1]!;
  assert.equal(minima.kind, 'minima');
  assert.ok(minima.kind === 'minima');
  assert.equal(minima.context, 'WHITE fix minimums (DME required)');
  assert.equal(minima.condition, 'Unless advised by ATC that cranes are down');
  assert.deepEqual(blocks[2], { kind: 'text', text: 'Temporary cranes beginning 4978FT from DER, 1555FT left of centerline.' });
  assert.deepEqual(record, before);
});
