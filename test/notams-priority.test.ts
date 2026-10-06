import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNotam } from '../src/layers/notams/parser';
import { airportNotamPriority } from '../src/layers/notams/priority';
import { notice } from './fixtures/notams';

test('airport priority recognizes closures and navaid outages without promoting mentions or other facilities', () => {
  const groups = [
    ['AD AP CLSD', 'RWY 09/27 CLSD', 'RWY 09/27 CLSD EXC EMERG ACFT', 'RWY 09 N 1000FT CLSD',
      'TWY A CLSD', 'TWY A BTN TWY B AND TWY C CLSD', 'TWY A, TWY B CLSD'],
    ['NAV ILS RWY 09 U/S', 'NAV ILS RWY 09 GP U/S', 'NAV VOR/DME U/S', 'NAV NDB U/S'],
    ['RWY 09 PAPI U/S', 'NAV ILS RWY 09 NOT MNT', 'APRON CLSD', 'SVC TWR CLSD', 'COM ATIS 120.5 U/S',
      'OBST TOWER LGT 370015N1220015W 350FT (200FT AGL) U/S',
      'IAP TEST, CA. RNAV (GPS) RWY 09, AMDT 1... LNAV MDA 600/HAT 400.',
      'IAP TEST, CA. ILS RWY 09, AMDT 1... FOR INOP ALS, INCREASE VISIBILITY TO 1 SM.'],
    ['RWY 09 WIP', 'RWY 09 NOT CLSD', 'TWY A IF CLSD USE TWY B',
      'NAV VOR NOT U/S', 'AD SEE FDC 6/1234', 'OBST CRANE 370015N1220015W 350FT (200FT AGL) FLAGGED',
      'AIRSPACE UAS WI AN AREA DEFINED AS 1NM RADIUS OF 370000N1210000W SFC-300FT AGL',
      'UNKNOWN WORDING ABOUT RWY CLSD AND NAV ILS U/S'],
  ];
  for (const [priority, texts] of groups.entries()) for (const text of texts) {
    for (const classification of ['DOMESTIC', 'FDC']) {
      const record = notice({ text, classification, translations: [] });
      assert.equal(airportNotamPriority(parseNotam(record)), priority, `${classification}: ${text}`);
    }
  }
});
